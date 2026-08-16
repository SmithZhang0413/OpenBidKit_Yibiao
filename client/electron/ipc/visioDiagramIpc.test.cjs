const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createConfigStore } = require('../services/configStore.cjs');

function loadWithElectronMock(modulePath, electronMock) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function createIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, handler) {
      listeners.set(channel, handler);
    },
  };
}

test('VisioDiagram IPC forwards workspace, component self-check and artifact operations', async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  const visioDiagramStore = {
    loadVisioDiagram: () => ({ step: 'requirements' }),
    saveRequirements: (value) => ({ saved: 'requirements', value }),
    savePlan: (value) => ({ saved: 'plan', value }),
    updateVisioDiagram: (value) => ({ saved: 'partial', value }),
    resolveArtifactPath: (value) => {
      calls.push(['resolve', value]);
      return 'C:\\workspace\\中文图表\\diagram.vsdx';
    },
  };
  const visioMcpService = {
    getStatus: () => ({ phase: 'stopped' }),
    runSelfCheck: async () => ({ success: true, tools: ['create_diagram'] }),
    restart: async () => ({ phase: 'ready' }),
  };
  const taskService = {
    resetVisioDiagram: async () => ({ success: true }),
  };
  const shell = {
    async openPath(value) {
      calls.push(['open', value]);
      return '';
    },
  };
  const { registerVisioDiagramIpc } = loadWithElectronMock('./visioDiagramIpc.cjs', { ipcMain, shell });
  registerVisioDiagramIpc({ visioDiagramStore, visioMcpService, taskService });

  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:load-state')(), { step: 'requirements' });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:save-requirements')({}, { title: '测试' }), {
    saved: 'requirements',
    value: { title: '测试' },
  });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:save-plan')({}, { schema_version: 1 }), {
    saved: 'plan',
    value: { schema_version: 1 },
  });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:update-step')({}, 'plan'), {
    saved: 'partial',
    value: { step: 'plan' },
  });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:clear')(), { success: true });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:get-component-status')(), { phase: 'stopped' });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:run-component-self-check')(), {
    success: true,
    tools: ['create_diagram'],
  });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:restart-component')(), { phase: 'ready' });
  assert.deepEqual(await ipcMain.handlers.get('visio-diagram:open-artifact')({}, 'revisions/中文图表/diagram.vsdx'), {
    success: true,
  });
  assert.deepEqual(calls, [
    ['resolve', 'revisions/中文图表/diagram.vsdx'],
    ['open', 'C:\\workspace\\中文图表\\diagram.vsdx'],
  ]);
});

test('task IPC exposes Visio plan, render and cancel channels with task subscription', () => {
  const ipcMain = createIpcMain();
  const calls = [];
  const taskService = {
    subscribe(sender) {
      calls.push(['subscribe', sender]);
    },
    startVisioPlanGeneration(payload) {
      calls.push(['plan', payload]);
      return { type: 'visio-plan-generation' };
    },
    startVisioRendering(payload) {
      calls.push(['render', payload]);
      return { type: 'visio-rendering' };
    },
    cancelVisioTask(type) {
      calls.push(['cancel', type]);
      return { success: true };
    },
  };
  const { registerTaskIpc } = loadWithElectronMock('./taskIpc.cjs', { ipcMain });
  registerTaskIpc({ taskService });

  const event = { sender: { id: 7 } };
  assert.deepEqual(ipcMain.handlers.get('tasks:start-visio-plan-generation')(event, { source: 'test' }), {
    type: 'visio-plan-generation',
  });
  assert.deepEqual(ipcMain.handlers.get('tasks:start-visio-rendering')(event, {}), {
    type: 'visio-rendering',
  });
  assert.deepEqual(ipcMain.handlers.get('tasks:cancel-visio-task')(event, 'visio-rendering'), {
    success: true,
  });
  assert.deepEqual(calls, [
    ['subscribe', event.sender],
    ['plan', { source: 'test' }],
    ['subscribe', event.sender],
    ['render', {}],
    ['subscribe', event.sender],
    ['cancel', 'visio-rendering'],
  ]);
});

test('preload exposes typed Visio bridge methods on the expected channels', async () => {
  let bridge;
  const invokes = [];
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push([channel, ...args]);
      return Promise.resolve({ channel });
    },
    send() {},
    on() {},
    removeListener() {},
  };
  loadWithElectronMock('../preload.cjs', {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name === 'yibiao') {
          bridge = value;
          return;
        }
        assert.equal(name, 'yibiaoClient');
      },
    },
    ipcRenderer,
  });

  await bridge.visioDiagram.loadState();
  await bridge.visioDiagram.saveRequirements({ title: '测试图' });
  await bridge.visioDiagram.runComponentSelfCheck();
  await bridge.visioDiagram.openArtifact('revisions/001/diagram.vsdx');
  await bridge.tasks.startVisioPlanGeneration({});
  await bridge.tasks.startVisioRendering({});
  await bridge.tasks.cancelVisioTask('visio-rendering');

  assert.deepEqual(invokes, [
    ['visio-diagram:load-state'],
    ['visio-diagram:save-requirements', { title: '测试图' }],
    ['visio-diagram:run-component-self-check'],
    ['visio-diagram:open-artifact', 'revisions/001/diagram.vsdx'],
    ['tasks:start-visio-plan-generation', {}],
    ['tasks:start-visio-rendering', {}],
    ['tasks:cancel-visio-task', 'visio-rendering'],
  ]);
});

test('configStore persists normalized custom Visio MCP runtime configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-visio-config-'));
  try {
    const store = createConfigStore({ getPath: () => root });
    assert.deepEqual(store.load().visio_mcp, {
      mode: 'bundled',
      command: '',
      args: [],
      cwd: '',
      env: {},
    });
    store.save({
      visio_mcp: {
        mode: 'custom',
        command: 'python',
        args: ['-m', 'visio_mcp'],
        cwd: 'C:\\中文运行目录',
        env: { VISIO_TEST: 1 },
      },
    });
    assert.deepEqual(store.load().visio_mcp, {
      mode: 'custom',
      command: 'python',
      args: ['-m', 'visio_mcp'],
      cwd: 'C:\\中文运行目录',
      env: { VISIO_TEST: '1' },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});