const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createVisioMcpService } = require('./visioMcpService.cjs');
const { resolveVisioMcpRuntime } = require('./visioMcpRuntime.cjs');

const fakeServerPath = path.join(__dirname, 'testing', 'fakeVisioMcpServer.cjs');

function createTestApp() {
  return {
    isPackaged: false,
    getAppPath: () => path.resolve(__dirname, '..', '..', '..'),
    getVersion: () => '0.1.0-test',
  };
}

test('resolveVisioMcpRuntime resolves custom commands and rejects unsupported platforms', () => {
  const app = createTestApp();
  const custom = resolveVisioMcpRuntime({
    app,
    platform: 'win32',
    config: { mode: 'custom', command: process.execPath, args: [fakeServerPath] },
  });
  assert.equal(custom.supported, true);
  assert.equal(custom.available, true);
  assert.equal(custom.command, process.execPath);
  assert.deepEqual(custom.args, [fakeServerPath]);
  assert.equal(custom.env.PYTHONUTF8, '1');

  const unsupported = resolveVisioMcpRuntime({ app, platform: 'darwin', config: { mode: 'custom', command: process.execPath } });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.available, false);
});

test('VisioMcpService completes the MCP lifecycle and serializes tool calls', async (context) => {
  const service = createVisioMcpService({
    app: createTestApp(),
    getRuntimeConfig: () => ({ mode: 'custom', command: process.execPath, args: [fakeServerPath] }),
  });
  context.after(() => service.close());

  const stopped = service.getStatus();
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.runtime.mode, 'custom');
  assert.equal(stopped.runtime.supported, true);
  assert.equal(stopped.runtime.available, true);

  const started = await service.start();
  assert.equal(started.phase, 'ready');
  assert.equal(started.server.name, 'yibiao-fake-visio-mcp');

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'delay', 'fail', 'soft_fail']);

  const echo = await service.callTool('echo', { text: '中文路径与内容' });
  assert.equal(echo.content[0].text, '中文路径与内容');

  const serializedAt = Date.now();
  await Promise.all([
    service.callTool('delay', { milliseconds: 80 }),
    service.callTool('delay', { milliseconds: 80 }),
  ]);
  assert.ok(Date.now() - serializedAt >= 130, 'Visio 工具调用必须串行执行');

  await assert.rejects(
    service.callTool('missing-tool'),
    (error) => error.code === 'VISIO_MCP_TOOL_NOT_FOUND',
  );
  await assert.rejects(
    service.callTool('fail'),
    (error) => error.code === 'VISIO_MCP_TOOL_ERROR' && error.message.includes('模拟 Visio 工具失败'),
  );
  await assert.rejects(
    service.callTool('soft_fail'),
    (error) => error.code === 'VISIO_MCP_TOOL_ERROR' && error.message.includes('模拟软错误'),
  );
  await assert.rejects(
    service.callTool('delay', { milliseconds: 200 }, { timeoutMs: 20 }),
    (error) => /timed out|timeout|超时/i.test(error.message),
  );

  const selfCheck = await service.runSelfCheck();
  assert.equal(selfCheck.success, true);
  assert.ok(selfCheck.tools.includes('echo'));

  await service.restart();
  assert.equal(service.getStatus().phase, 'ready');
  await service.close();
  assert.equal(service.getStatus().phase, 'stopped');
});

test('VisioMcpService rejects calls cancelled before execution', async () => {
  const controller = new AbortController();
  controller.abort(new Error('用户取消'));
  const service = createVisioMcpService({
    app: createTestApp(),
    getRuntimeConfig: () => ({ mode: 'custom', command: process.execPath, args: [fakeServerPath] }),
  });
  await assert.rejects(
    service.callTool('echo', { text: '不会执行' }, { signal: controller.signal }),
    (error) => error.code === 'VISIO_MCP_CANCELLED' && error.message === '用户取消',
  );
  assert.equal(service.getStatus().phase, 'stopped');
});
