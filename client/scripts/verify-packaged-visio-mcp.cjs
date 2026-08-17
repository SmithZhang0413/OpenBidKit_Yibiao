const fs = require('node:fs');
const path = require('node:path');
const { verifySidecarRoot } = require('./verify-visio-mcp.cjs');
const { resolveVisioMcpRuntime } = require('../electron/services/visio/visioMcpRuntime.cjs');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function walkDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => {
    if (!item.isDirectory()) return [];
    const itemPath = path.join(root, item.name);
    return [itemPath, ...walkDirs(itemPath)];
  });
}

function findResourceRoot(releaseDir, platform) {
  if (platform === 'darwin') {
    const appDir = walkDirs(releaseDir).find((dir) => dir.endsWith('.app'));
    if (!appDir) throw new Error(`没有找到 macOS .app：${releaseDir}`);
    return path.join(appDir, 'Contents', 'Resources');
  }
  if (platform === 'win32') {
    const unpackedDir = walkDirs(releaseDir).find((dir) => path.basename(dir).toLowerCase() === 'win-unpacked');
    if (!unpackedDir) throw new Error(`没有找到 win-unpacked：${releaseDir}`);
    return path.join(unpackedDir, 'resources');
  }
  throw new Error(`暂不支持校验平台：${platform}`);
}

function verifyArtifactExtensions(releaseDir) {
  const files = fs.readdirSync(releaseDir, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name);
  ['.exe', '.zip', '.msi'].forEach((extension) => {
    if (!files.some((name) => name.toLowerCase().endsWith(extension))) {
      throw new Error(`Windows Release 缺少 ${extension} 安装产物：${releaseDir}`);
    }
  });
}

async function verifyPackagedVisioMcp({ releaseDir, platform, arch, requireArtifacts = false }) {
  const resourceRoot = findResourceRoot(releaseDir, platform);
  const visioRoot = path.join(resourceRoot, 'visio-mcp');
  if (platform === 'darwin') {
    if (fs.existsSync(visioRoot)) throw new Error(`macOS 安装包不应包含 Visio MCP Sidecar：${visioRoot}`);
    return { platform, arch, resourceRoot, absent: true };
  }
  if (platform !== 'win32' || arch !== 'x64') throw new Error(`M08-A 仅支持 win32-x64，当前为 ${platform}-${arch}`);
  const directories = fs.existsSync(visioRoot)
    ? fs.readdirSync(visioRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : [];
  if (directories.length !== 1 || directories[0] !== 'win32-x64') {
    throw new Error(`Windows 安装包应只包含 win32-x64 Sidecar，实际为：${directories.join(', ') || '(empty)'}`);
  }
  const targetRoot = path.join(visioRoot, 'win32-x64');
  const result = await verifySidecarRoot(targetRoot);
  const runtime = resolveVisioMcpRuntime({
    app: { isPackaged: true },
    platform,
    arch,
    resourcesPath: resourceRoot,
    config: { mode: 'bundled' },
  });
  if (!runtime.available || path.resolve(runtime.command) !== path.resolve(result.executablePath)) {
    throw new Error(`安装包 bundled 解析路径与 Sidecar 资源不一致：${runtime.command}`);
  }
  if (requireArtifacts) verifyArtifactExtensions(releaseDir);
  return { platform, arch, resourceRoot, targetRoot, result };
}

async function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const releaseDir = path.resolve(readArg('--release', 'release'));
  const output = await verifyPackagedVisioMcp({ releaseDir, platform, arch, requireArtifacts: hasFlag('--require-artifacts') });
  console.log(JSON.stringify({
    message: platform === 'darwin' ? 'Packaged Visio MCP absence verified' : 'Packaged Visio MCP verified',
    platform,
    arch,
    resource_root: output.resourceRoot,
    target_root: output.targetRoot || null,
    exe_sha256: output.result?.executableHash || null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
}

module.exports = { findResourceRoot, verifyPackagedVisioMcp };
