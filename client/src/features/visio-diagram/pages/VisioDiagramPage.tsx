import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  VisioDiagramPlan,
  VisioDiagramRequirements,
  VisioDiagramState,
  VisioDiagramStep,
  VisioDiagramTaskState,
  VisioDiagramType,
} from '../../../shared/types';
import { useToast } from '../../../shared/ui';

const diagramTypeLabels: Record<VisioDiagramType, string> = {
  flowchart: '流程图',
  cross_functional_flowchart: '跨职能流程图',
  org_chart: '组织结构图',
  block_diagram: '框图',
  data_flow_diagram: '数据流图',
  network_diagram: '网络拓扑图',
};

const initialRequirements: VisioDiagramRequirements = {
  title: '',
  requirementText: '',
  diagramTypeMode: 'auto',
  diagramType: undefined,
  pageOrientation: 'portrait',
};

const taskStatusLabels: Record<VisioDiagramTaskState['status'], string> = {
  running: '正在执行',
  success: '已完成',
  error: '执行失败',
  cancelled: '已取消',
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

function getVisibleStep(state: VisioDiagramState): VisioDiagramStep {
  if (state.step === 'result' && !state.activeArtifact) return state.plan ? 'plan' : 'requirements';
  if (state.step === 'plan' && !state.plan) return 'requirements';
  return state.step;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function VisioDiagramPage() {
  const { showToast } = useToast();
  const [state, setState] = useState<VisioDiagramState | null>(null);
  const [requirements, setRequirements] = useState<VisioDiagramRequirements>(initialRequirements);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notifiedTaskRef = useRef('');

  const loadState = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const nextState = await window.yibiao.visioDiagram.loadState();
      setState(nextState);
      setRequirements(nextState.requirements);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const unsubscribe = window.yibiao.tasks.onTaskEvent<unknown, unknown, unknown, VisioDiagramState>((event) => {
      if (!event.visioDiagram) return;
      setState(event.visioDiagram);

      const status = event.task.status;
      if (!['success', 'error', 'cancelled'].includes(status)) return;
      const notificationKey = `${event.task.task_id}:${status}`;
      if (notifiedTaskRef.current === notificationKey) return;
      notifiedTaskRef.current = notificationKey;

      if (status === 'success') {
        showToast(event.task.type === 'visio-rendering' ? 'Visio 文件已生成' : '图表计划已生成', 'success');
      } else if (status === 'error') {
        showToast(event.task.error || 'Visio 任务执行失败', 'error');
      } else {
        showToast('Visio 任务已取消', 'info');
      }
    });

    window.yibiao.tasks.getActiveTasks().catch((error) => {
      console.warn('获取 Visio 后台任务状态失败', error);
    });
    return unsubscribe;
  }, [showToast]);

  useEffect(() => {
    if (state) setRequirements(state.requirements);
  }, [state?.requirements]);

  const visibleStep = state ? getVisibleStep(state) : 'requirements';
  const planBusy = state?.planTask?.status === 'running';
  const renderBusy = state?.renderTask?.status === 'running';
  const anyTaskBusy = Boolean(planBusy || renderBusy || submitting);

  const navigateToStep = async (step: VisioDiagramStep) => {
    if (!state || anyTaskBusy || step === visibleStep) return;
    try {
      setState(await window.yibiao.visioDiagram.updateStep(step));
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    }
  };

  const startPlanGeneration = async (event?: FormEvent) => {
    event?.preventDefault();
    const requirementText = requirements.requirementText.trim();
    if (!requirementText) {
      showToast('请先填写图表需求', 'info');
      return;
    }
    if (requirements.diagramTypeMode === 'manual' && !requirements.diagramType) {
      showToast('请选择图表类型', 'info');
      return;
    }

    const normalizedRequirements: VisioDiagramRequirements = {
      ...requirements,
      title: requirements.title.trim(),
      requirementText,
      diagramType: requirements.diagramTypeMode === 'manual' ? requirements.diagramType : undefined,
    };

    setSubmitting(true);
    try {
      const savedState = await window.yibiao.visioDiagram.saveRequirements(normalizedRequirements);
      setState(savedState);
      const task = await window.yibiao.tasks.startVisioPlanGeneration({}) as VisioDiagramTaskState;
      setState((current) => current ? { ...current, planTask: task } : current);
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const regeneratePlan = async () => {
    setSubmitting(true);
    try {
      const task = await window.yibiao.tasks.startVisioPlanGeneration({}) as VisioDiagramTaskState;
      setState((current) => current ? { ...current, planTask: task } : current);
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const startRendering = async () => {
    if (!state?.plan) {
      showToast('请先生成图表计划', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const task = await window.yibiao.tasks.startVisioRendering({}) as VisioDiagramTaskState;
      setState((current) => current ? { ...current, renderTask: task } : current);
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTask = async (type: 'visio-plan-generation' | 'visio-rendering') => {
    try {
      const result = await window.yibiao.tasks.cancelVisioTask(type);
      if (!result.success) showToast(result.message || '当前任务无法取消', 'info');
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    }
  };

  const openArtifact = async () => {
    const documentPath = state?.activeArtifact?.documentPath;
    if (!documentPath) return;
    try {
      await window.yibiao.visioDiagram.openArtifact(documentPath);
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    }
  };

  return (
    <div className="visio-diagram-page">
      <header className="visio-diagram-header">
        <div>
          <span className="section-kicker">VISIO MCP</span>
          <h1>Visio 自动绘图</h1>
          <p>描述业务图表，大模型生成结构计划，再由本地 Visio 输出可编辑文件。</p>
        </div>
        {state && (
          <div className="visio-diagram-header-meta" aria-label="当前工作区信息">
            <span>计划版本</span>
            <strong>V{state.planRevision}</strong>
          </div>
        )}
      </header>

      {state && (
        <VisioWorkflowRail
          currentStep={visibleStep}
          state={state}
          disabled={anyTaskBusy}
          onStepChange={navigateToStep}
        />
      )}

      <main className="visio-diagram-content">
        {loading ? (
          <div className="visio-workflow-empty" role="status">正在载入 Visio 工作区…</div>
        ) : loadError ? (
          <div className="visio-workflow-empty is-error">
            <strong>工作区载入失败</strong>
            <p>{loadError}</p>
            <button type="button" className="secondary-action" onClick={loadState}>重新载入</button>
          </div>
        ) : state && visibleStep === 'requirements' ? (
          <RequirementsStep
            requirements={requirements}
            task={state.planTask}
            busy={anyTaskBusy}
            onRequirementsChange={setRequirements}
            onSubmit={startPlanGeneration}
            onCancel={() => cancelTask('visio-plan-generation')}
          />
        ) : state && visibleStep === 'plan' && state.plan ? (
          <PlanStep
            plan={state.plan}
            planRevision={state.planRevision}
            planTask={state.planTask}
            renderTask={state.renderTask}
            busy={anyTaskBusy}
            onBack={() => navigateToStep('requirements')}
            onRegenerate={regeneratePlan}
            onRender={startRendering}
            onCancelPlan={() => cancelTask('visio-plan-generation')}
            onCancelRender={() => cancelTask('visio-rendering')}
          />
        ) : state && visibleStep === 'result' && state.activeArtifact ? (
          <ResultStep
            state={state}
            busy={anyTaskBusy}
            onBack={() => navigateToStep('plan')}
            onOpen={openArtifact}
            onRender={startRendering}
            onCancel={() => cancelTask('visio-rendering')}
          />
        ) : (
          <div className="visio-workflow-empty">当前步骤暂无可用数据，请返回需求步骤重新生成。</div>
        )}
      </main>
    </div>
  );
}

interface VisioWorkflowRailProps {
  currentStep: VisioDiagramStep;
  state: VisioDiagramState;
  disabled: boolean;
  onStepChange: (step: VisioDiagramStep) => void;
}

function VisioWorkflowRail({ currentStep, state, disabled, onStepChange }: VisioWorkflowRailProps) {
  const steps: Array<{ id: VisioDiagramStep; number: string; label: string; hint: string; available: boolean }> = [
    { id: 'requirements', number: '01', label: '图表需求', hint: '定义内容与版式', available: true },
    { id: 'plan', number: '02', label: '图表计划', hint: '核对节点与连线', available: Boolean(state.plan) },
    { id: 'result', number: '03', label: 'Visio 结果', hint: '打开可编辑文件', available: Boolean(state.activeArtifact) },
  ];

  return (
    <nav className="visio-workflow-rail" aria-label="Visio 绘图步骤">
      {steps.map((step, index) => {
        const active = step.id === currentStep;
        return (
          <div className="visio-workflow-step-wrap" key={step.id}>
            <button
              type="button"
              className={`visio-workflow-step${active ? ' is-active' : ''}${step.available && !active ? ' is-available' : ''}`}
              aria-current={active ? 'step' : undefined}
              disabled={disabled || !step.available}
              onClick={() => onStepChange(step.id)}
            >
              <span className="visio-workflow-number">{step.number}</span>
              <span>
                <strong>{step.label}</strong>
                <small>{step.hint}</small>
              </span>
            </button>
            {index < steps.length - 1 && <span className="visio-workflow-connector" aria-hidden="true" />}
          </div>
        );
      })}
    </nav>
  );
}

interface RequirementsStepProps {
  requirements: VisioDiagramRequirements;
  task?: VisioDiagramTaskState;
  busy: boolean;
  onRequirementsChange: (requirements: VisioDiagramRequirements) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

function RequirementsStep({ requirements, task, busy, onRequirementsChange, onSubmit, onCancel }: RequirementsStepProps) {
  return (
    <section className="visio-step-layout is-requirements">
      <form className="visio-workflow-panel visio-requirements-form" onSubmit={onSubmit}>
        <div className="visio-panel-heading">
          <div>
            <span>第一步</span>
            <h2>描述你要绘制的图表</h2>
          </div>
          <p>写清对象、关系和期望层级，图表计划会自动拆分节点与连线。</p>
        </div>

        <label className="visio-field">
          <span>图表标题</span>
          <input
            type="text"
            value={requirements.title}
            maxLength={120}
            placeholder="例如：项目实施审批流程"
            onChange={(event) => onRequirementsChange({ ...requirements, title: event.target.value })}
          />
          <small>可选；留空时由模型根据需求生成。</small>
        </label>

        <label className="visio-field is-primary">
          <span>图表需求</span>
          <textarea
            value={requirements.requirementText}
            maxLength={12000}
            placeholder="描述需要展示的流程、参与角色、关键节点、判断条件与前后关系……"
            onChange={(event) => onRequirementsChange({ ...requirements, requirementText: event.target.value })}
          />
          <small>{requirements.requirementText.length.toLocaleString('zh-CN')} / 12,000 字</small>
        </label>

        <div className="visio-field-grid">
          <label className="visio-field">
            <span>图表类型</span>
            <select
              value={requirements.diagramTypeMode === 'auto' ? 'auto' : requirements.diagramType || 'flowchart'}
              onChange={(event) => {
                const value = event.target.value;
                onRequirementsChange(value === 'auto'
                  ? { ...requirements, diagramTypeMode: 'auto', diagramType: undefined }
                  : { ...requirements, diagramTypeMode: 'manual', diagramType: value as VisioDiagramType });
              }}
            >
              <option value="auto">自动判断</option>
              {Object.entries(diagramTypeLabels).map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="visio-field">
            <span>页面方向</span>
            <select
              value={requirements.pageOrientation}
              onChange={(event) => onRequirementsChange({
                ...requirements,
                pageOrientation: event.target.value as VisioDiagramRequirements['pageOrientation'],
              })}
            >
              <option value="portrait">纵向</option>
              <option value="landscape">横向</option>
            </select>
          </label>
        </div>

        <div className="visio-panel-actions">
          <span>生成后可先核对计划，再调用本地 Visio。</span>
          <button type="submit" className="primary-action" disabled={busy}>
            {task?.status === 'running' ? '正在生成计划…' : '生成图表计划'}
          </button>
        </div>
      </form>

      {task && <VisioTaskPanel task={task} label="图表计划生成" onCancel={onCancel} />}
    </section>
  );
}

interface PlanStepProps {
  plan: VisioDiagramPlan;
  planRevision: number;
  planTask?: VisioDiagramTaskState;
  renderTask?: VisioDiagramTaskState;
  busy: boolean;
  onBack: () => void;
  onRegenerate: () => void;
  onRender: () => void;
  onCancelPlan: () => void;
  onCancelRender: () => void;
}

function PlanStep({ plan, planRevision, planTask, renderTask, busy, onBack, onRegenerate, onRender, onCancelPlan, onCancelRender }: PlanStepProps) {
  const nodeNames = useMemo(() => new Map(plan.nodes.map((node) => [node.id, node.text])), [plan.nodes]);
  const visibleTask = planTask?.status === 'running' ? planTask : renderTask;

  return (
    <section className="visio-step-layout">
      <div className="visio-workflow-panel visio-plan-panel">
        <div className="visio-panel-heading is-inline">
          <div>
            <span>第二步 · 计划 V{planRevision}</span>
            <h2>{plan.title}</h2>
          </div>
          <div className="visio-plan-badges">
            <span>{diagramTypeLabels[plan.diagram_type]}</span>
            <span>{plan.page.orientation === 'landscape' ? '横向页面' : '纵向页面'}</span>
          </div>
        </div>

        <div className="visio-plan-columns">
          <section className="visio-plan-list" aria-labelledby="visio-plan-nodes-title">
            <header>
              <h3 id="visio-plan-nodes-title">节点</h3>
              <span>{plan.nodes.length}</span>
            </header>
            <div className="visio-plan-items">
              {plan.nodes.map((node, index) => (
                <article className="visio-plan-item" key={node.id}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{node.text}</strong>
                    <small>{node.kind}{node.group_id ? ` · ${node.group_id}` : ''}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="visio-plan-list" aria-labelledby="visio-plan-edges-title">
            <header>
              <h3 id="visio-plan-edges-title">连线</h3>
              <span>{plan.edges.length}</span>
            </header>
            <div className="visio-plan-items">
              {plan.edges.map((edge) => (
                <article className="visio-plan-edge" key={edge.id}>
                  <div>
                    <strong>{nodeNames.get(edge.from) || edge.from}</strong>
                    <span aria-hidden="true">→</span>
                    <strong>{nodeNames.get(edge.to) || edge.to}</strong>
                  </div>
                  <small>{edge.label || edge.kind || '顺序连接'}</small>
                </article>
              ))}
            </div>
          </section>
        </div>

        {plan.notes?.length ? (
          <aside className="visio-plan-notes">
            <strong>计划说明</strong>
            <p>{plan.notes.join('；')}</p>
          </aside>
        ) : null}

        <div className="visio-panel-actions is-split">
          <button type="button" className="secondary-action" disabled={busy} onClick={onBack}>返回修改需求</button>
          <div>
            <button type="button" className="secondary-action" disabled={busy} onClick={onRegenerate}>重新生成计划</button>
            <button type="button" className="primary-action" disabled={busy} onClick={onRender}>生成 Visio 文件</button>
          </div>
        </div>
      </div>

      {visibleTask && (
        <VisioTaskPanel
          task={visibleTask}
          label={visibleTask.type === 'visio-rendering' ? 'Visio 文件生成' : '图表计划生成'}
          onCancel={visibleTask.type === 'visio-rendering' ? onCancelRender : onCancelPlan}
        />
      )}
    </section>
  );
}

interface ResultStepProps {
  state: VisioDiagramState;
  busy: boolean;
  onBack: () => void;
  onOpen: () => void;
  onRender: () => void;
  onCancel: () => void;
}

function ResultStep({ state, busy, onBack, onOpen, onRender, onCancel }: ResultStepProps) {
  const artifact = state.activeArtifact!;
  const manifest = artifact.manifest;
  const fileName = artifact.documentPath.split(/[\\/]/).pop() || manifest.document.file_name;

  return (
    <section className="visio-step-layout is-result">
      <div className="visio-workflow-panel visio-result-panel">
        <div className="visio-result-mark" aria-hidden="true">V</div>
        <div className="visio-result-copy">
          <span>第三步 · 已生成</span>
          <h2>{manifest.title}</h2>
          <p>{fileName}</p>
        </div>
        <button type="button" className="primary-action" disabled={busy} onClick={onOpen}>在 Visio 中打开</button>
      </div>

      <div className="visio-result-stats" aria-label="Visio 产物摘要">
        <article><span>节点</span><strong>{manifest.node_count}</strong></article>
        <article><span>连线</span><strong>{manifest.edge_count}</strong></article>
        <article><span>页面</span><strong>{Math.max(1, manifest.previews.length)}</strong></article>
        <article><span>文件大小</span><strong>{formatBytes(manifest.document.bytes)}</strong></article>
      </div>

      <div className="visio-result-footer">
        <div>
          <span>产物版本</span>
          <strong>{artifact.artifactRevision}</strong>
        </div>
        <div className="visio-result-actions">
          <button type="button" className="secondary-action" disabled={busy} onClick={onBack}>返回图表计划</button>
          <button type="button" className="secondary-action" disabled={busy} onClick={onRender}>重新生成 Visio</button>
        </div>
      </div>

      {state.renderTask && <VisioTaskPanel task={state.renderTask} label="Visio 文件生成" onCancel={onCancel} />}
    </section>
  );
}

interface VisioTaskPanelProps {
  task: VisioDiagramTaskState;
  label: string;
  onCancel: () => void;
}

function VisioTaskPanel({ task, label, onCancel }: VisioTaskPanelProps) {
  const progress = Math.min(100, Math.max(0, Math.round(task.progress || 0)));
  const logs = task.logs.slice(-4);

  return (
    <aside className={`visio-task-panel is-${task.status}`} aria-live="polite">
      <div className="visio-task-heading">
        <div>
          <span>{label}</span>
          <strong>{taskStatusLabels[task.status]}</strong>
        </div>
        <span>{progress}%</span>
      </div>
      <div className="visio-task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {logs.length > 0 && (
        <ul>
          {logs.map((log, index) => <li key={`${index}-${log}`}>{log}</li>)}
        </ul>
      )}
      {task.error && <p className="visio-task-error">{task.error}</p>}
      {task.status === 'running' && (
        <button type="button" className="text-button" onClick={onCancel}>取消任务</button>
      )}
    </aside>
  );
}

export default VisioDiagramPage;