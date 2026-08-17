import type { ReactNode } from 'react';
import type {
  VisioDiagramEdge,
  VisioDiagramGroup,
  VisioDiagramNode,
  VisioDiagramPlan,
  VisioDiagramType,
} from '../../../shared/types';
import {
  createNextVisioId,
  removeVisioPlanGroup,
  removeVisioPlanNode,
} from '../services/visioPlanDraft';

const diagramTypeLabels: Record<VisioDiagramType, string> = {
  flowchart: '流程图',
  cross_functional_flowchart: '跨职能流程图',
  org_chart: '组织结构图',
  block_diagram: '框图',
  data_flow_diagram: '数据流图',
  network_diagram: '网络拓扑图',
};

const edgeKindLabels: Array<{ value: NonNullable<VisioDiagramEdge['kind']>; label: string }> = [
  { value: 'normal', label: '普通连接' },
  { value: 'conditional', label: '条件连接' },
  { value: 'dependency', label: '依赖连接' },
  { value: 'bidirectional', label: '双向连接' },
];

interface VisioPlanEditorProps {
  plan: VisioDiagramPlan;
  disabled: boolean;
  onChange: (plan: VisioDiagramPlan) => void;
}

function VisioPlanEditor({ plan, disabled, onChange }: VisioPlanEditorProps) {
  const groups = plan.groups || [];

  const updateGroup = (index: number, partial: Partial<VisioDiagramGroup>) => {
    onChange({
      ...plan,
      groups: groups.map((group, groupIndex) => groupIndex === index ? { ...group, ...partial } : group),
    });
  };

  const addGroup = () => {
    const id = createNextVisioId('group', groups.map((group) => group.id));
    onChange({
      ...plan,
      groups: [...groups, { id, title: '新分组', order: groups.length }],
    });
  };

  const removeGroup = (groupId: string) => {
    onChange(removeVisioPlanGroup(plan, groupId));
  };

  const updateNode = (index: number, partial: Partial<VisioDiagramNode>) => {
    onChange({
      ...plan,
      nodes: plan.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...partial } : node),
    });
  };

  const addNode = () => {
    const id = createNextVisioId('node', plan.nodes.map((node) => node.id));
    onChange({
      ...plan,
      nodes: [...plan.nodes, { id, text: '新节点', kind: 'process' }],
    });
  };

  const removeNode = (nodeId: string) => {
    onChange(removeVisioPlanNode(plan, nodeId));
  };

  const updateEdge = (index: number, partial: Partial<VisioDiagramEdge>) => {
    onChange({
      ...plan,
      edges: plan.edges.map((edge, edgeIndex) => edgeIndex === index ? { ...edge, ...partial } : edge),
    });
  };

  const addEdge = () => {
    if (plan.nodes.length < 2) return;
    const id = createNextVisioId('edge', plan.edges.map((edge) => edge.id));
    onChange({
      ...plan,
      edges: [
        ...plan.edges,
        {
          id,
          from: plan.nodes[0].id,
          to: plan.nodes[1].id,
          kind: 'normal',
        },
      ],
    });
  };

  const removeEdge = (edgeId: string) => {
    onChange({
      ...plan,
      edges: plan.edges.filter((edge) => edge.id !== edgeId),
    });
  };

  return (
    <div className='visio-plan-editor'>
      <section className='visio-plan-editor-overview' aria-label='图表基本信息'>
        <label className='visio-editor-field is-wide'>
          <span>图表标题</span>
          <input
            type='text'
            maxLength={200}
            value={plan.title}
            disabled={disabled}
            onChange={(event) => onChange({ ...plan, title: event.target.value })}
          />
        </label>
        <label className='visio-editor-field'>
          <span>图表类型</span>
          <select
            value={plan.diagram_type}
            disabled={disabled}
            onChange={(event) => onChange({ ...plan, diagram_type: event.target.value as VisioDiagramType })}
          >
            {Object.entries(diagramTypeLabels).map(([value, label]) => (
              <option value={value} key={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className='visio-editor-field'>
          <span>页面方向</span>
          <select
            value={plan.page.orientation}
            disabled={disabled}
            onChange={(event) => onChange({
              ...plan,
              page: { ...plan.page, orientation: event.target.value as VisioDiagramPlan['page']['orientation'] },
            })}
          >
            <option value='portrait'>纵向</option>
            <option value='landscape'>横向</option>
          </select>
        </label>
        <label className='visio-editor-field'>
          <span>页面名称</span>
          <input
            type='text'
            maxLength={100}
            value={plan.page.name}
            disabled={disabled}
            onChange={(event) => onChange({ ...plan, page: { ...plan.page, name: event.target.value } })}
          />
        </label>
      </section>

      <PlanEditorSection title='分组' count={groups.length} actionLabel='添加分组' disabled={disabled} onAdd={addGroup}>
        {groups.length === 0 ? (
          <div className='visio-editor-empty'>当前计划没有分组，节点将直接排列在页面中。</div>
        ) : groups.map((group, index) => (
          <article className='visio-editor-card' key={group.id}>
            <div className='visio-editor-card-meta'>
              <span>分组 ID</span>
              <code>{group.id}</code>
            </div>
            <label className='visio-editor-field is-wide'>
              <span>分组名称</span>
              <input
                type='text'
                maxLength={200}
                value={group.title}
                disabled={disabled}
                onChange={(event) => updateGroup(index, { title: event.target.value })}
              />
            </label>
            <button type='button' className='text-button is-danger' disabled={disabled} onClick={() => removeGroup(group.id)}>
              删除分组
            </button>
          </article>
        ))}
      </PlanEditorSection>

      <PlanEditorSection title='节点' count={plan.nodes.length} actionLabel='添加节点' disabled={disabled} onAdd={addNode}>
        {plan.nodes.map((node, index) => (
          <article className='visio-editor-card is-node' key={node.id}>
            <div className='visio-editor-card-meta'>
              <span>节点 ID</span>
              <code>{node.id}</code>
            </div>
            <label className='visio-editor-field is-wide'>
              <span>节点内容</span>
              <input
                type='text'
                maxLength={1000}
                value={node.text}
                disabled={disabled}
                onChange={(event) => updateNode(index, { text: event.target.value })}
              />
            </label>
            <label className='visio-editor-field'>
              <span>节点类型</span>
              <input
                type='text'
                maxLength={100}
                value={node.kind}
                disabled={disabled}
                onChange={(event) => updateNode(index, { kind: event.target.value })}
              />
            </label>
            <label className='visio-editor-field'>
              <span>所属分组</span>
              <select
                value={node.group_id || ''}
                disabled={disabled}
                onChange={(event) => updateNode(index, { group_id: event.target.value || undefined })}
              >
                <option value=''>不分组</option>
                {groups.map((group) => <option value={group.id} key={group.id}>{group.title || group.id}</option>)}
              </select>
            </label>
            <button type='button' className='text-button is-danger' disabled={disabled} onClick={() => removeNode(node.id)}>
              删除节点
            </button>
          </article>
        ))}
      </PlanEditorSection>

      <PlanEditorSection
        title='连线'
        count={plan.edges.length}
        actionLabel='添加连线'
        disabled={disabled || plan.nodes.length < 2}
        onAdd={addEdge}
      >
        {plan.edges.length === 0 ? (
          <div className='visio-editor-empty'>当前计划没有连线；至少存在两个节点后可以添加。</div>
        ) : plan.edges.map((edge, index) => (
          <article className='visio-editor-card is-edge' key={edge.id}>
            <div className='visio-editor-card-meta'>
              <span>连线 ID</span>
              <code>{edge.id}</code>
            </div>
            <label className='visio-editor-field'>
              <span>起点</span>
              <select
                value={edge.from}
                disabled={disabled}
                onChange={(event) => updateEdge(index, { from: event.target.value })}
              >
                {plan.nodes.map((node) => <option value={node.id} key={node.id}>{node.text || node.id}</option>)}
              </select>
            </label>
            <label className='visio-editor-field'>
              <span>终点</span>
              <select
                value={edge.to}
                disabled={disabled}
                onChange={(event) => updateEdge(index, { to: event.target.value })}
              >
                {plan.nodes.map((node) => <option value={node.id} key={node.id}>{node.text || node.id}</option>)}
              </select>
            </label>
            <label className='visio-editor-field is-wide'>
              <span>连线说明</span>
              <input
                type='text'
                maxLength={300}
                value={edge.label || ''}
                disabled={disabled}
                placeholder='可选'
                onChange={(event) => updateEdge(index, { label: event.target.value })}
              />
            </label>
            <label className='visio-editor-field'>
              <span>连线类型</span>
              <select
                value={edge.kind || 'normal'}
                disabled={disabled}
                onChange={(event) => updateEdge(index, { kind: event.target.value as VisioDiagramEdge['kind'] })}
              >
                {edgeKindLabels.map((kind) => <option value={kind.value} key={kind.value}>{kind.label}</option>)}
              </select>
            </label>
            <button type='button' className='text-button is-danger' disabled={disabled} onClick={() => removeEdge(edge.id)}>
              删除连线
            </button>
          </article>
        ))}
      </PlanEditorSection>
    </div>
  );
}

interface PlanEditorSectionProps {
  title: string;
  count: number;
  actionLabel: string;
  disabled: boolean;
  onAdd: () => void;
  children: ReactNode;
}

function PlanEditorSection({ title, count, actionLabel, disabled, onAdd, children }: PlanEditorSectionProps) {
  return (
    <section className='visio-editor-section'>
      <header>
        <div>
          <h3>{title}</h3>
          <span>{count}</span>
        </div>
        <button type='button' className='inline-action' disabled={disabled} onClick={onAdd}>{actionLabel}</button>
      </header>
      <div className='visio-editor-list'>{children}</div>
    </section>
  );
}

export default VisioPlanEditor;
