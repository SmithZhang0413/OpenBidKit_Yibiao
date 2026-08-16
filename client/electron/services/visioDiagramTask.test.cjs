const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAiService } = require('./aiService.cjs');
const { createTaskService } = require('./taskService.cjs');

function createPlan(title = '投标审批流程') {
  return {
    schema_version: 1,
    title,
    diagram_type: 'flowchart',
    page: { name: '审批流程', orientation: 'landscape' },
    groups: [],
    nodes: [
      { id: 'start', text: '开始', kind: 'start' },
      { id: 'review', text: '复核文件', kind: 'process' },
      { id: 'end', text: '提交', kind: 'end' },
    ],
    edges: [
      { id: 'edge_1', from: 'start', to: 'review', kind: 'normal' },
      { id: 'edge_2', from: 'review', to: 'end', kind: 'normal' },
    ],
    notes: [],
  };
}

function createMemoryVisioStore(overrides = {}) {
  let state = {
    step: 'requirements',
    requirements: {
      title: '投标审批流程',
      requirementText: '收到投标文件后复核，确认无误后提交。',
      diagramTypeMode: 'auto',
      pageOrientation: 'landscape',
    },
    plan: undefined,
    planRevision: 0,
    activeArtifact: undefined,
    planTask: undefined,
    renderTask: undefined,
    ...overrides,
  };
  return {
    loadVisioDiagram() {
      return state;
    },
    updateVisioDiagram(partial) {
      state = { ...state, ...partial };
      return state;
    },
    savePlan(plan) {
      state = {
        ...state,
        step: 'plan',
        plan,
        planRevision: state.planRevision + 1,
        activeArtifact: undefined,
        renderTask: undefined,
      };
      return state;
    },
    allocateArtifactDirectory(revision, taskId) {
      return path.join(os.tmpdir(), `visio-task-${revision}-${taskId}`);
    },
    publishArtifact(result, context) {
      state = {
        ...state,
        step: 'result',
        activeArtifact: {
          planRevision: context.planRevision,
          artifactRevision: context.taskId,
          documentPath: result.document_path,
        },
      };
      return state;
    },
    clearVisioDiagram() {
      state = createMemoryVisioStore().loadVisioDiagram();
      return { success: true, state };
    },
  };
}

function createPassiveStore(loadName, updateName) {
  let state = {};
  return {
    [loadName]() {
      return state;
    },
    [updateName](partial) {
      state = { ...state, ...partial };
      return state;
    },
    clearTechnicalPlan() {
      state = {};
      return { success: true, state };
    },
  };
}

function createTaskHarness({ visioStore, renderer, aiService }) {
  return createTaskService({
    aiService: {
      ...aiService,
      withQueueScope() {
        return this;
      },
      resumeQueueScope() {},
    },
    agentService: {
      bindTaskContext() {
        return {};
      },
      deletePersistentTask() {},
    },
    autoConfirmationService: {
      register() {},
      unregister() {},
      suppress() {},
    },
    technicalPlanStore: createPassiveStore('loadTechnicalPlan', 'updateTechnicalPlan'),
    rejectionCheckStore: createPassiveStore('loadRejectionCheck', 'updateRejectionCheck'),
    duplicateCheckStore: createPassiveStore('loadDuplicateCheck', 'updateDuplicateCheck'),
    visioDiagramStore: visioStore,
    knowledgeBaseService: {},
    duplicateCheckService: {},
    visioDiagramRenderer: renderer,
  });
}

function waitForTask(service, type, status, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`等待任务状态超时：${type} ${status}`));
    }, timeoutMs);
    unsubscribe = service.subscribeCallback((event) => {
      if (event.task?.type !== type || event.task?.status !== status) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

test('taskService generates a plan, renders an artifact and persists progress', async () => {
  const visioStore = createMemoryVisioStore();
  const plan = createPlan();
  const aiService = {
    async collectJsonResponse(request) {
      assert.equal(request.signal.aborted, false);
      request.progressCallback('模型已返回计划，正在校验。');
      request.validator(plan);
      return plan;
    },
  };
  const renderer = {
    async render(inputPlan, options) {
      assert.deepEqual(inputPlan, plan);
      options.onProgress({ stage: 'shapes', message: '正在绘制图形', percent: 45 });
      options.onProgress({ stage: 'complete', message: '绘制完成', percent: 100 });
      return {
        output_dir: options.outputDir,
        document_path: path.join(options.outputDir, 'diagram.vsdx'),
        plan_path: path.join(options.outputDir, 'plan.json'),
        manifest_path: path.join(options.outputDir, 'manifest.json'),
        preview_paths: [path.join(options.outputDir, 'preview-01.png')],
        manifest: { node_count: 3, edge_count: 2, previews: [{}] },
      };
    },
  };
  const service = createTaskHarness({ visioStore, renderer, aiService });

  service.startVisioPlanGeneration({});
  const planEvent = await waitForTask(service, 'visio-plan-generation', 'success');
  assert.equal(planEvent.visioDiagram.planRevision, 1);
  assert.equal(planEvent.task.stats.node_count, 3);

  service.startVisioRendering({});
  const renderEvent = await waitForTask(service, 'visio-rendering', 'success');
  assert.equal(renderEvent.visioDiagram.step, 'result');
  assert.equal(renderEvent.visioDiagram.activeArtifact.planRevision, 1);
  assert.equal(renderEvent.task.stats.page_count, 1);
});

test('rendering requires a saved DiagramPlan', () => {
  const visioStore = createMemoryVisioStore();
  const service = createTaskHarness({
    visioStore,
    renderer: { async render() {} },
    aiService: { async collectJsonResponse() { return createPlan(); } },
  });
  service.startVisioRendering({});
  return waitForTask(service, 'visio-rendering', 'error').then((event) => {
    assert.match(event.task.error, /请先生成并保存图表计划/);
  });
});

test('Visio tasks are mutually exclusive and rendering can be cancelled', async () => {
  const priorArtifact = { planRevision: 1, documentPath: 'revisions/prior/diagram.vsdx' };
  const visioStore = createMemoryVisioStore({
    step: 'plan',
    plan: createPlan(),
    planRevision: 1,
    activeArtifact: priorArtifact,
  });
  const aiService = { async collectJsonResponse() { return createPlan('新计划'); } };
  const renderer = {
    render(_plan, { signal, onProgress }) {
      onProgress({ stage: 'document', message: '正在创建文档', percent: 12 });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const service = createTaskHarness({ visioStore, renderer, aiService });

  service.startVisioRendering({});
  assert.throws(() => service.startVisioPlanGeneration({}), /正在执行“Visio 图表绘制”/);
  const cancelledEvent = waitForTask(service, 'visio-rendering', 'cancelled');
  const result = service.cancelVisioTask('visio-rendering');
  assert.equal(result.success, true);
  const event = await cancelledEvent;
  assert.match(event.task.error, /取消/);
  assert.deepEqual(event.visioDiagram.activeArtifact, priorArtifact);
});

test('taskService recovers interrupted Visio tasks as retryable errors', () => {
  const staleTask = {
    task_id: 'stale-plan',
    type: 'visio-plan-generation',
    status: 'running',
    progress: 55,
    logs: ['生成中'],
    started_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:01.000Z',
  };
  const visioStore = createMemoryVisioStore({ planTask: staleTask });
  const service = createTaskHarness({
    visioStore,
    renderer: { async render() {} },
    aiService: { async collectJsonResponse() { return createPlan(); } },
  });

  service.getActiveTasks();
  const recovered = visioStore.loadVisioDiagram().planTask;
  assert.equal(recovered.status, 'error');
  assert.equal(recovered.progress, 100);
  assert.match(recovered.error, /未完成/);
});

test('AI JSON requests abort queued and in-flight work with the parent signal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-ai-cancel-'));
  const originalFetch = global.fetch;
  const controller = new AbortController();
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('fetch aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    const service = createAiService({
      app: { getPath: () => root },
      configStore: {
        load() {
          return {
            api_key: 'test-key',
            model_name: 'test-model',
            base_url: 'https://example.invalid/v1',
            request_mode: 'normal',
            text_request_concurrency: 1,
          };
        },
      },
    });
    const promise = service.requestJson({
      messages: [{ role: 'user', content: '返回 JSON' }],
      signal: controller.signal,
      timeout_ms: 30000,
    });
    const reason = new Error('用户取消了 Visio 图表任务');
    reason.code = 'TASK_CANCELLED';
    controller.abort(reason);
    await assert.rejects(promise, /用户取消了 Visio 图表任务/);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});