const fs = require('node:fs');
const path = require('node:path');
const { createVisioMcpService } = require('../electron/services/visio/visioMcpService.cjs');
const { createVisioDiagramRenderer } = require('../electron/services/visio/visioDiagramRenderer.cjs');

function parseArguments(argv) {
  const options = { args: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--arg=')) {
      options.args.push(item.slice('--arg='.length));
      continue;
    }
    const key = item.startsWith('--') ? item.slice(2) : '';
    if (!key || index + 1 >= argv.length) throw new Error(`无法识别参数：${item}`);
    const value = argv[index + 1];
    index += 1;
    if (key === 'arg') options.args.push(value);
    else options[key] = value;
  }
  return options;
}

function printUsage() {
  process.stdout.write([
    '用法：',
    '  node scripts/visio-mcp-render.cjs --plan <plan.json> --output <目录> [--command <程序>] [--arg=<参数>]',
    '',
    '示例：',
    '  node scripts/visio-mcp-render.cjs --plan electron/services/visio/testing/sample-flowchart-plan.json --output C:\\Temp\\visio-output --command C:\\path\\python.exe --arg=-m --arg=visio_mcp',
    '',
  ].join('\n'));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.plan || !options.output) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const planPath = path.resolve(options.plan);
  const outputDirectory = path.resolve(options.output);
  const plan = JSON.parse(await fs.promises.readFile(planPath, 'utf-8'));
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('用户取消 Visio 绘图')));

  const app = {
    isPackaged: false,
    getAppPath: () => path.resolve(__dirname, '..'),
    getVersion: () => '0.1.0',
  };
  const runtimeConfig = options.command
    ? { mode: 'custom', command: options.command, args: options.args }
    : { mode: 'bundled' };
  const visioMcpService = createVisioMcpService({ app, getRuntimeConfig: () => runtimeConfig });
  const renderer = createVisioDiagramRenderer({ visioMcpService });

  try {
    const result = await renderer.render(plan, {
      outputDir: outputDirectory,
      signal: controller.signal,
      onProgress: ({ percent, message }) => process.stdout.write(`[${String(percent).padStart(3, ' ')}%] ${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await visioMcpService.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
