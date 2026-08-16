const {
  SUPPORTED_DIAGRAM_TYPES,
  VISIO_DIAGRAM_PLAN_SCHEMA,
  validateDiagramPlan,
} = require('./visio/visioDiagramPlan.cjs');

const NODE_KINDS = Object.freeze({
  flowchart: ['start', 'end', 'process', 'decision', 'subprocess', 'document', 'data', 'database', 'external_data'],
  cross_functional_flowchart: ['start', 'end', 'process', 'decision', 'subprocess', 'document', 'data'],
  org_chart: ['executive', 'manager', 'position', 'consultant', 'vacancy', 'assistant', 'staff'],
  block_diagram: ['box', 'component', 'service', 'circle', 'decision', 'layered'],
  data_flow_diagram: ['process', 'external', 'external_entity', 'data_store', 'object', 'multiple_process'],
  network_diagram: ['server', 'router', 'switch', 'firewall', 'hub', 'bridge', 'modem', 'access_point', 'user', 'printer', 'cloud', 'building', 'data_center'],
});

function normalizeDiagramPlanResponse(value) {
  return value?.result && typeof value.result === 'object' ? value.result : value;
}

function assertTaskActive(taskControl, fallbackMessage) {
  if (!taskControl?.signal?.aborted) return;
  throw taskControl.signal.reason || new Error(fallbackMessage);
}

function buildVisioPlanMessages(requirements = {}) {
  const selectedType = requirements.diagramTypeMode === 'manual'
    && SUPPORTED_DIAGRAM_TYPES.includes(requirements.diagramType)
    ? requirements.diagramType
    : '';
  const typeRule = selectedType
    ? `diagram_type 必须使用用户指定的 ${selectedType}。`
    : `请从 ${SUPPORTED_DIAGRAM_TYPES.join('、')} 中选择最合适的 diagram_type。`;

  return [
    {
      role: 'system',
      content: `你是专业的 Visio 图表规划助手。你只负责把用户需求转换成语义化 DiagramPlan，不调用 Visio，不生成坐标以外的程序命令。

必须遵守：
1. 只返回一个 JSON 对象，不输出 Markdown、解释或代码块。
2. 使用简体中文编写标题、节点文字、分组标题和连线标签；所有 id 只使用英文字母、数字、下划线或连字符。
3. 节点数量以清晰表达需求为准，避免重复节点；每条连线的 from/to 必须引用真实节点。
4. page.name 应是简洁中文页名，page.orientation 使用 portrait 或 landscape。
5. row/column 仅在需要明确泳道或层级时填写；其余布局由程序确定。
6. kind 必须优先使用所选图表类型支持的值。
7. schema_version 固定为 1。`,
    },
    {
      role: 'user',
      content: `请生成 DiagramPlan。

图表标题：${String(requirements.title || '').trim() || '请根据需求拟定'}
图表需求：
${String(requirements.requirementText || '').trim()}

图表类型规则：${typeRule}
页面方向：${requirements.pageOrientation === 'portrait' ? 'portrait' : 'landscape'}

各图表类型支持的节点 kind：
${JSON.stringify(NODE_KINDS, null, 2)}

目标 JSON Schema：
${JSON.stringify(VISIO_DIAGRAM_PLAN_SCHEMA, null, 2)}`,
    },
  ];
}

async function collectDiagramPlan(aiService, request) {
  if (aiService?.collectJsonResponse) return aiService.collectJsonResponse(request);
  if (aiService?.requestJson) return aiService.requestJson(request);
  throw new Error('AI 服务尚未初始化');
}

async function runVisioPlanGenerationTask({ aiService, workspaceStore, updateTask, taskControl }) {
  const stored = workspaceStore.loadVisioDiagram() || {};
  const requirements = stored.requirements || {};
  if (!String(requirements.requirementText || '').trim()) {
    throw new Error('请先填写图表需求');
  }

  let logs = ['开始生成 Visio 图表计划。'];
  const report = (message, progress) => {
    if (message && logs[logs.length - 1] !== message) logs = [...logs, message];
    const state = workspaceStore.loadVisioDiagram();
    updateTask({ status: 'running', progress, logs }, state);
  };

  report('正在分析图表类型、节点和连接关系。', 15);
  const plan = await collectDiagramPlan(aiService, {
    messages: buildVisioPlanMessages(requirements),
    response_format: { type: 'json_object' },
    logTitle: 'Visio图表-DiagramPlan生成',
    progressLabel: 'Visio图表计划',
    failureMessage: '模型返回的 Visio 图表计划格式无效',
    normalizer: normalizeDiagramPlanResponse,
    validator: validateDiagramPlan,
    progressCallback: (message) => report(message, 65),
    signal: taskControl.signal,
  });
  assertTaskActive(taskControl, 'Visio 图表计划生成已取消');

  const validatedPlan = validateDiagramPlan(plan);
  report('图表计划校验通过，正在保存新修订。', 90);
  const state = workspaceStore.savePlan(validatedPlan);
  const finalLogs = [...logs, 'Visio 图表计划生成完成。'];
  updateTask({
    status: 'success',
    progress: 100,
    logs: finalLogs,
    stats: {
      diagram_type: validatedPlan.diagram_type,
      node_count: validatedPlan.nodes.length,
      edge_count: validatedPlan.edges.length,
      plan_revision: state.planRevision,
    },
  }, state);
}

async function runVisioRenderingTask({
  workspaceStore,
  updateTask,
  taskControl,
  visioDiagramRenderer,
}) {
  if (!visioDiagramRenderer?.render) {
    throw new Error('Visio 图表渲染服务尚未初始化');
  }

  const stored = workspaceStore.loadVisioDiagram() || {};
  const planRevision = Number(stored.planRevision || 0);
  if (!stored.plan || !planRevision) {
    throw new Error('请先生成并保存图表计划');
  }
  const plan = validateDiagramPlan(stored.plan);

  let logs = ['开始调用 Visio MCP 绘制图表。'];
  const outputDir = workspaceStore.allocateArtifactDirectory(planRevision, taskControl.taskId);
  const report = ({ stage, message, percent }) => {
    if (message && logs[logs.length - 1] !== message) logs = [...logs, message];
    const state = workspaceStore.loadVisioDiagram();
    updateTask({
      status: 'running',
      progress: Math.max(1, Math.min(99, Number(percent || 0))),
      logs,
      stats: { stage, plan_revision: planRevision },
    }, state);
  };

  const result = await visioDiagramRenderer.render(plan, {
    outputDir,
    signal: taskControl.signal,
    onProgress: report,
  });
  assertTaskActive(taskControl, 'Visio 图表绘制已取消');

  const latest = workspaceStore.loadVisioDiagram();
  if (Number(latest.planRevision || 0) !== planRevision) {
    const error = new Error('绘图期间图表计划已发生变化，请重新生成');
    error.code = 'VISIO_PLAN_REVISION_CHANGED';
    throw error;
  }

  const state = workspaceStore.publishArtifact(result, {
    planRevision,
    taskId: taskControl.taskId,
  });
  const finalLogs = [...logs, 'Visio 图表绘制完成。'];
  updateTask({
    status: 'success',
    progress: 100,
    logs: finalLogs,
    stats: {
      stage: 'complete',
      plan_revision: planRevision,
      node_count: result.manifest?.node_count || plan.nodes.length,
      edge_count: result.manifest?.edge_count || plan.edges.length,
      page_count: result.manifest?.previews?.length || result.preview_paths?.length || 0,
    },
  }, state);
}

module.exports = {
  buildVisioPlanMessages,
  normalizeDiagramPlanResponse,
  runVisioPlanGenerationTask,
  runVisioRenderingTask,
};