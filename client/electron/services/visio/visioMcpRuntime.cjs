const fs = require('node:fs');
const path = require('node:path');

const VISIO_MCP_EXECUTABLE = 'visio-mcp.exe';

function normalizeMode(value) {
  return value === 'custom' ? 'custom' : 'bundled';
}

function normalizeArgs(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeEnvironment(value) {
  const entries = value && typeof value === 'object' ? Object.entries(value) : [];
  return Object.fromEntries(entries
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => [String(key), String(item)]));
}

function resolveCustomCommand(app, config) {
  const configured = String(config.command || '').trim();
  if (!configured) return { command: '', available: false, reason: '尚未配置自定义 Visio MCP 启动命令' };

  const hasPathSeparator = configured.includes('/') || configured.includes('\\');
  if (!path.isAbsolute(configured) && !hasPathSeparator) {
    return { command: configured, available: true, reason: '' };
  }

  const baseDir = String(config.cwd || '').trim() || app?.getAppPath?.() || process.cwd();
  const command = path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(baseDir, configured);
  return {
    command,
    available: fs.existsSync(command),
    reason: fs.existsSync(command) ? '' : `找不到自定义 Visio MCP 启动程序：${command}`,
  };
}

function resolveBundledCommand({ app, arch, resourcesPath }) {
  const platformDirectory = `win32-${arch}`;
  const baseDir = app?.isPackaged
    ? path.join(resourcesPath || process.resourcesPath || '', 'visio-mcp', platformDirectory)
    : path.join(app?.getAppPath?.() || process.cwd(), 'vendor', 'visio-mcp', platformDirectory);
  const command = path.join(baseDir, VISIO_MCP_EXECUTABLE);
  return {
    command,
    available: fs.existsSync(command),
    reason: fs.existsSync(command) ? '' : `未找到内置 Visio MCP 运行时：${command}`,
  };
}

function resolveVisioMcpRuntime({
  app,
  config = {},
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
} = {}) {
  const mode = normalizeMode(config.mode);
  if (platform !== 'win32') {
    return {
      supported: false,
      available: false,
      mode,
      source: mode,
      command: '',
      args: [],
      cwd: '',
      env: {},
      reason: 'Visio 自动绘图仅支持安装了 Microsoft Visio 的 Windows 系统',
    };
  }

  const resolved = mode === 'custom'
    ? resolveCustomCommand(app, config)
    : resolveBundledCommand({ app, arch, resourcesPath });

  return {
    supported: true,
    available: resolved.available,
    mode,
    source: mode,
    command: resolved.command,
    args: normalizeArgs(config.args),
    cwd: String(config.cwd || '').trim(),
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...normalizeEnvironment(config.env),
    },
    reason: resolved.reason,
  };
}

module.exports = {
  resolveVisioMcpRuntime,
};
