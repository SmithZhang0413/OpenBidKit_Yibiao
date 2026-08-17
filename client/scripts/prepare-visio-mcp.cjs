const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { probeSidecar, sha256, verifySidecarRoot } = require('./verify-visio-mcp.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'sidecar', 'visio-mcp');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'visio-mcp');
const TARGET_ROOT = path.join(VENDOR_ROOT, 'win32-x64');
const BACKUP_ROOT = path.join(VENDOR_ROOT, '.win32-x64.backup');
const TEMP_ROOT = path.join(ROOT, '.tmp-visio-mcp-build');
const STAGING_ROOT = path.join(TEMP_ROOT, 'staging', 'win32-x64');
const PYTHON_VERSION = '3.14.7';
const UPSTREAM = {
  name: 'visio-mcp',
  version: '0.1.2',
  wheel: 'visio_mcp-0.1.2-py3-none-any.whl',
  url: 'https://files.pythonhosted.org/packages/68/2a/fabd7de52d67d98f5c02d88c6b46cfaf7c0ccba5600ef245341403cb0b2e/visio_mcp-0.1.2-py3-none-any.whl',
  sha256: 'c6720716de0decd6d5a79651af28ce3760434bb6a7606305c834e2afee939f46',
};

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function run(command, args, options = {}) {
  console.log(`> ${path.basename(command)} ${args.join(' ')}`);
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function runText(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf-8', ...options }).trim();
}

function safeRemove(targetPath) {
  const resolvedRoot = path.resolve(ROOT);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) || resolvedTarget === resolvedRoot) {
    throw new Error(`拒绝清理工作区外路径：${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function downloadFile(url, targetPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'yibiao-visio-mcp-builder' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) return reject(new Error('下载 visio-mcp wheel 重定向过多'));
        return downloadFile(new URL(response.headers.location, url).toString(), targetPath, redirectCount + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`下载 visio-mcp wheel 失败：HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(targetPath);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function inspectPython(python) {
  const script = [
    'import json, platform, sys, sysconfig',
    'print(json.dumps({"version": platform.python_version(), "bits": platform.architecture()[0], "platform": sys.platform, "gil_disabled": int(sysconfig.get_config_var("Py_GIL_DISABLED") or 0), "base_prefix": sys.base_prefix}))',
  ].join('; ');
  const info = JSON.parse(runText(python, ['-c', script]));
  if (info.version !== PYTHON_VERSION || info.bits !== '64bit' || info.platform !== 'win32' || info.gil_disabled !== 0) {
    throw new Error(`M08-A 需要 CPython ${PYTHON_VERSION} Windows x64 常规 GIL 构建，实际为 ${JSON.stringify(info)}`);
  }
  return info;
}

function canonicalName(value) {
  return String(value || '').toLowerCase().replace(/[-_.]+/g, '-');
}

function parseLockedHashes() {
  const result = new Map();
  let current = null;
  for (const line of fs.readFileSync(path.join(SOURCE_ROOT, 'requirements.lock'), 'utf-8').split(/\r?\n/)) {
    const packageMatch = line.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:==[^\s\\]+|\s+@\s+\S+)/);
    if (packageMatch) {
      current = canonicalName(packageMatch[1]);
      result.set(current, []);
    }
    const hashMatch = line.match(/--hash=sha256:([a-f0-9]{64})/i);
    if (current && hashMatch) result.get(current).push(hashMatch[1].toLowerCase());
  }
  return result;
}

function inspectDistributions(venvPython) {
  const script = String.raw`
import importlib.metadata as metadata
import json
import os
import sys

items = []
for dist in metadata.distributions():
    name = dist.metadata.get('Name') or ''
    license_files = []
    for item in dist.files or []:
        base = os.path.basename(str(item)).lower()
        if base.startswith(('license', 'copying', 'notice')):
            located = os.fspath(dist.locate_file(item))
            if os.path.isfile(located):
                license_files.append(located)
    items.append({
        'name': name,
        'version': dist.version,
        'license': dist.metadata.get('License-Expression') or dist.metadata.get('License') or '',
        'license_files': sorted(set(license_files)),
    })
print(json.dumps({'base_prefix': sys.base_prefix, 'distributions': sorted(items, key=lambda item: item['name'].lower())}))
`;
  return JSON.parse(runText(venvPython, ['-c', script]));
}

function sanitizeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function copyNormalizedLicense(sourcePath, targetPath) {
  const text = fs.readFileSync(sourcePath, 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
  fs.writeFileSync(targetPath, `${text}\n`, 'utf-8');
}

function copyLicenses(distributionInfo, lockedHashes) {
  const licenseRoot = path.join(STAGING_ROOT, 'licenses');
  fs.mkdirSync(licenseRoot, { recursive: true });
  const dependencies = distributionInfo.distributions
    .filter((item) => lockedHashes.has(canonicalName(item.name)))
    .map((item) => {
    const copied = [];
    item.license_files.forEach((sourcePath, index) => {
      const name = `${sanitizeFileName(item.name)}-${index + 1}-${sanitizeFileName(path.basename(sourcePath))}`;
      copyNormalizedLicense(sourcePath, path.join(licenseRoot, name));
      copied.push(`licenses/${name}`);
    });
    return {
      name: item.name,
      version: item.version,
      license: String(item.license || '').trim(),
      locked_hashes: lockedHashes.get(canonicalName(item.name)) || [],
      license_files: copied,
    };
    });

  const pythonLicenseCandidates = [
    path.join(distributionInfo.base_prefix, 'LICENSE.txt'),
    path.join(distributionInfo.base_prefix, 'LICENSE'),
  ];
  const pythonLicense = pythonLicenseCandidates.find((item) => fs.existsSync(item));
  if (!pythonLicense) throw new Error(`没有找到 CPython ${PYTHON_VERSION} 许可证`);
  copyNormalizedLicense(pythonLicense, path.join(licenseRoot, 'Python-LICENSE.txt'));

  const notices = [
    '# Third-Party Notices',
    '',
    `This Windows sidecar embeds CPython ${PYTHON_VERSION} and the following Python distributions.`,
    '',
    ...dependencies.flatMap((item) => [
      `## ${item.name} ${item.version}`,
      '',
      `License metadata: ${item.license || '(not declared in package metadata)'}`,
      '',
      `Included license files: ${item.license_files.length ? item.license_files.join(', ') : '(none found in distribution)'}`,
      '',
    ]),
  ];
  fs.writeFileSync(path.join(STAGING_ROOT, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'), 'utf-8');
  return dependencies;
}

function writeVersion(dependencies) {
  const versions = new Map(dependencies.map((item) => [canonicalName(item.name), item.version]));
  const lines = [
    `visio-mcp=${UPSTREAM.version}`,
    `python=${PYTHON_VERSION}`,
    `pyinstaller=${versions.get('pyinstaller')}`,
    `pyinstaller-hooks-contrib=${versions.get('pyinstaller-hooks-contrib')}`,
    `mcp=${versions.get('mcp')}`,
    `pywin32=${versions.get('pywin32')}`,
    'platform=win32',
    'arch=x64',
  ];
  fs.writeFileSync(path.join(STAGING_ROOT, 'VERSION'), `${lines.join('\n')}\n`, 'utf-8');
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => {
    const filePath = path.join(root, item.name);
    return item.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function writeSha256Sums() {
  const excluded = path.join(STAGING_ROOT, 'SHA256SUMS');
  const lines = walkFiles(STAGING_ROOT).filter((item) => item !== excluded).sort().map((filePath) => {
    const relative = path.relative(STAGING_ROOT, filePath).replace(/\\/g, '/');
    return `${sha256(filePath)}  ${relative}`;
  });
  fs.writeFileSync(excluded, `${lines.join('\n')}\n`, 'utf-8');
}

function assertFrozenVersions(dependencies) {
  const versions = new Map(dependencies.map((item) => [canonicalName(item.name), item.version]));
  const required = new Map([
    ['visio-mcp', '0.1.2'],
    ['mcp', '1.27.0'],
    ['pywin32', '311'],
    ['pyinstaller', '6.22.1'],
    ['pyinstaller-hooks-contrib', '2026.6'],
  ]);
  for (const [name, version] of required) {
    if (versions.get(name) !== version) throw new Error(`${name} 应为 ${version}，实际为 ${versions.get(name) || '(missing)'}`);
  }
}

async function buildStaging(python) {
  safeRemove(TEMP_ROOT);
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const wheelPath = path.join(TEMP_ROOT, UPSTREAM.wheel);
  console.log(`Downloading frozen upstream wheel: ${UPSTREAM.url}`);
  await downloadFile(UPSTREAM.url, wheelPath);
  if (sha256(wheelPath) !== UPSTREAM.sha256) throw new Error('visio-mcp 官方 wheel SHA256 校验失败');

  const venvRoot = path.join(TEMP_ROOT, 'venv');
  run(python, ['-m', 'venv', venvRoot]);
  const venvPython = path.join(venvRoot, 'Scripts', 'python.exe');
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '-r', path.join(SOURCE_ROOT, 'requirements.lock')]);

  const distRoot = path.join(TEMP_ROOT, 'dist');
  const workRoot = path.join(TEMP_ROOT, 'work');
  run(venvPython, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', distRoot, '--workpath', workRoot, path.join(SOURCE_ROOT, 'visio-mcp.spec')]);
  const builtExecutable = path.join(distRoot, 'visio-mcp.exe');
  if (!fs.existsSync(builtExecutable)) throw new Error(`PyInstaller 没有生成：${builtExecutable}`);

  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const stagedExecutable = path.join(STAGING_ROOT, 'visio-mcp.exe');
  fs.copyFileSync(builtExecutable, stagedExecutable);
  const distributionInfo = inspectDistributions(venvPython);
  const dependencies = copyLicenses(distributionInfo, parseLockedHashes());
  assertFrozenVersions(dependencies);
  writeVersion(dependencies);

  const probe = await probeSidecar(stagedExecutable);
  const manifest = {
    schema_version: 1,
    name: 'visio-mcp-sidecar',
    platform: 'win32',
    arch: 'x64',
    key: 'win32-x64',
    transport: 'stdio',
    upstream: UPSTREAM,
    build: {
      python: PYTHON_VERSION,
      pyinstaller: '6.22.1',
      pyinstaller_hooks_contrib: '2026.6',
    },
    artifact: {
      file: 'visio-mcp.exe',
      size: fs.statSync(stagedExecutable).size,
      sha256: sha256(stagedExecutable),
    },
    dependencies,
    required_tools: JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'required-tools.json'), 'utf-8')),
    actual_tools: probe.tools,
    tool_count: probe.tool_count,
    diagram_type_count: probe.diagram_type_count,
    server: probe.server,
    built_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(STAGING_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  writeSha256Sums();
  await verifySidecarRoot(STAGING_ROOT);
  return manifest;
}

async function publishStaging() {
  fs.mkdirSync(VENDOR_ROOT, { recursive: true });
  safeRemove(BACKUP_ROOT);
  let movedPrevious = false;
  try {
    if (fs.existsSync(TARGET_ROOT)) {
      fs.renameSync(TARGET_ROOT, BACKUP_ROOT);
      movedPrevious = true;
    }
    fs.renameSync(STAGING_ROOT, TARGET_ROOT);
    await verifySidecarRoot(TARGET_ROOT);
    safeRemove(BACKUP_ROOT);
  } catch (error) {
    if (fs.existsSync(TARGET_ROOT)) safeRemove(TARGET_ROOT);
    if (movedPrevious && fs.existsSync(BACKUP_ROOT)) fs.renameSync(BACKUP_ROOT, TARGET_ROOT);
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`M08-A Sidecar 只允许在 Windows x64 构建，当前为 ${process.platform}-${process.arch}`);
  }
  const python = readArg('--python', process.env.YIBIAO_VISIO_MCP_PYTHON || 'python');
  inspectPython(python);
  try {
    const manifest = await buildStaging(python);
    await publishStaging();
    console.log(JSON.stringify({
      message: 'Prepared Visio MCP sidecar',
      target: TARGET_ROOT,
      exe_sha256: manifest.artifact.sha256,
      tool_count: manifest.tool_count,
      diagram_type_count: manifest.diagram_type_count,
    }, null, 2));
  } finally {
    safeRemove(TEMP_ROOT);
  }
}

main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
