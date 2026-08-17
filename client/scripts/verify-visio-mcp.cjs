const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createVisioMcpService } = require('../electron/services/visio/visioMcpService.cjs');
const { resolveVisioMcpRuntime } = require('../electron/services/visio/visioMcpRuntime.cjs');

const ROOT = path.resolve(__dirname, '..');
const TARGET_KEY = 'win32-x64';
const EXPECTED_DIAGRAM_TYPE_COUNT = 22;

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => {
    const filePath = path.join(root, item.name);
    return item.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function readPeMachine(executablePath) {
  const buffer = fs.readFileSync(executablePath);
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') return 0;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return 0;
  return buffer.readUInt16LE(peOffset + 4);
}

function parseSha256Sums(filePath) {
  return new Map(fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
    if (!match) throw new Error(`SHA256SUMS 格式错误：${line}`);
    return [match[2].replace(/\//g, path.sep), match[1].toLowerCase()];
  }));
}

function verifyStaticSidecar(targetRoot) {
  const required = ['visio-mcp.exe', 'VERSION', 'manifest.json', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md'];
  required.forEach((name) => {
    const filePath = path.join(targetRoot, name);
    if (!fs.existsSync(filePath)) throw new Error(`Visio MCP 产物缺少文件：${filePath}`);
  });
  const licenseRoot = path.join(targetRoot, 'licenses');
  if (!fs.existsSync(licenseRoot) || walkFiles(licenseRoot).length === 0) {
    throw new Error(`Visio MCP 产物缺少许可证：${licenseRoot}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, 'manifest.json'), 'utf-8'));
  if (manifest.schema_version !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64'
      || manifest.key !== TARGET_KEY || manifest.transport !== 'stdio') {
    throw new Error('Visio MCP manifest 的 schema、平台、架构或传输方式不符合 M08-A 契约');
  }
  const executablePath = path.join(targetRoot, manifest.artifact?.file || '');
  if (path.basename(executablePath).toLowerCase() !== 'visio-mcp.exe' || !fs.existsSync(executablePath)) {
    throw new Error(`Visio MCP manifest 指向了无效可执行文件：${executablePath}`);
  }
  if (readPeMachine(executablePath) !== 0x8664) throw new Error(`Visio MCP EXE 不是 PE x64：${executablePath}`);
  const executableHash = sha256(executablePath);
  if (manifest.artifact.sha256 !== executableHash || manifest.artifact.size !== fs.statSync(executablePath).size) {
    throw new Error('Visio MCP EXE 的大小或 SHA256 与 manifest 不一致');
  }

  const requiredTools = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecar', 'visio-mcp', 'required-tools.json'), 'utf-8'));
  const actualTools = Array.isArray(manifest.actual_tools) ? manifest.actual_tools : [];
  const missingTools = requiredTools.filter((name) => !actualTools.includes(name));
  if (missingTools.length) throw new Error(`Visio MCP 缺少易标必需工具：${missingTools.join(', ')}`);
  if (manifest.tool_count !== actualTools.length || manifest.diagram_type_count !== EXPECTED_DIAGRAM_TYPE_COUNT) {
    throw new Error('Visio MCP manifest 的工具数量或图表类型数量不符合冻结结果');
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
    throw new Error('Visio MCP manifest 缺少完整依赖清单');
  }
  const unlockedDependencies = manifest.dependencies.filter((item) => !Array.isArray(item.locked_hashes) || item.locked_hashes.length === 0);
  if (unlockedDependencies.length) {
    throw new Error(`Visio MCP manifest 包含未锁定依赖：${unlockedDependencies.map((item) => item.name).join(', ')}`);
  }

  const sums = parseSha256Sums(path.join(targetRoot, 'SHA256SUMS'));
  for (const [relativePath, expectedHash] of sums) {
    const filePath = path.resolve(targetRoot, relativePath);
    if (!filePath.startsWith(`${path.resolve(targetRoot)}${path.sep}`) || !fs.existsSync(filePath)) {
      throw new Error(`SHA256SUMS 包含无效文件：${relativePath}`);
    }
    if (sha256(filePath) !== expectedHash) throw new Error(`文件 SHA256 不一致：${relativePath}`);
  }
  const covered = new Set([...sums.keys()].map((item) => item.toLowerCase()));
  ['visio-mcp.exe', 'manifest.json', 'THIRD_PARTY_NOTICES.md', ...walkFiles(licenseRoot).map((item) => path.relative(targetRoot, item))]
    .forEach((item) => {
      if (!covered.has(item.toLowerCase())) throw new Error(`SHA256SUMS 未覆盖：${item}`);
    });

  const licenseNames = walkFiles(licenseRoot).map((item) => path.basename(item).toLowerCase());
  ['visio-mcp', 'python', 'pyinstaller'].forEach((name) => {
    if (!licenseNames.some((item) => item.includes(name))) throw new Error(`许可证目录缺少 ${name} 声明`);
  });
  return { manifest, executablePath, executableHash };
}

function parseDiagramTypeCount(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n');
  const payload = JSON.parse(text);
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload?.diagram_types)) return payload.diagram_types.length;
  throw new Error('list_diagram_types 未返回可识别的 JSON 数组');
}

function findSidecarProcesses(executablePath) {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:YIBIAO_VISIO_MCP_EXE }",
    "$items | ForEach-Object { $_.ProcessId }",
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, YIBIAO_VISIO_MCP_EXE: executablePath },
    timeout: 15000,
  }).trim();
  return output ? output.split(/\s+/).filter(Boolean) : [];
}

async function waitForNoSidecarProcesses(executablePath) {
  const deadline = Date.now() + 5000;
  let processIds = [];
  do {
    processIds = findSidecarProcesses(executablePath);
    if (!processIds.length) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`Visio MCP 关闭后仍有残留进程：${processIds.join(', ')}`);
}

async function probeSidecar(executablePath) {
  const logs = [];
  const service = createVisioMcpService({
    app: { getVersion: () => '0.1.0' },
    runtimeResolver: () => ({
      supported: true,
      available: true,
      mode: 'bundled',
      source: 'bundled',
      command: executablePath,
      args: [],
      cwd: path.dirname(executablePath),
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      reason: '',
    }),
    logger: { write(event, payload) { logs.push({ event, payload }); } },
    requestTimeoutMs: 60000,
  });
  try {
    const selfCheck = await service.runSelfCheck();
    const diagramTypeResult = await service.callTool('list_diagram_types');
    const diagramTypeCount = parseDiagramTypeCount(diagramTypeResult);
    if (diagramTypeCount !== EXPECTED_DIAGRAM_TYPE_COUNT) {
      throw new Error(`Visio MCP 图表类型应为 ${EXPECTED_DIAGRAM_TYPE_COUNT}，实际为 ${diagramTypeCount}`);
    }
    return {
      server: selfCheck.server,
      tools: [...selfCheck.tools].sort(),
      tool_count: selfCheck.tools.length,
      diagram_type_count: diagramTypeCount,
      startup_ms: selfCheck.duration_ms,
      stderr_events: logs.filter((item) => item.event === 'sidecar.stderr').length,
    };
  } finally {
    await service.close();
    await waitForNoSidecarProcesses(executablePath);
  }
}

async function verifySidecarRoot(targetRoot, { protocol = true } = {}) {
  const staticResult = verifyStaticSidecar(targetRoot);
  if (!protocol) return staticResult;
  const probe = await probeSidecar(staticResult.executablePath);
  const manifestTools = [...staticResult.manifest.actual_tools].sort();
  if (JSON.stringify(probe.tools) !== JSON.stringify(manifestTools)) {
    throw new Error('真实 MCP 工具清单与 manifest 不一致');
  }
  return { ...staticResult, probe };
}

async function main() {
  const targetRoot = path.resolve(readArg('--root', path.join(ROOT, 'vendor', 'visio-mcp', TARGET_KEY)));
  const result = await verifySidecarRoot(targetRoot);
  const runtime = resolveVisioMcpRuntime({
    app: { isPackaged: false, getAppPath: () => ROOT },
    platform: 'win32',
    arch: 'x64',
    config: { mode: 'bundled' },
  });
  if (!runtime.available || path.resolve(runtime.command) !== path.resolve(result.executablePath)) {
    throw new Error(`开发环境 bundled 解析路径与正式 vendor 不一致：${runtime.command}`);
  }
  console.log(JSON.stringify({
    message: 'Visio MCP sidecar verified',
    root: targetRoot,
    exe_sha256: result.executableHash,
    server: result.probe.server,
    tool_count: result.probe.tool_count,
    diagram_type_count: result.probe.diagram_type_count,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
}

module.exports = { probeSidecar, sha256, verifySidecarRoot, verifyStaticSidecar };
