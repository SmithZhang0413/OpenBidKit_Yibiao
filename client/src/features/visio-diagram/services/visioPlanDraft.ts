import type { VisioDiagramPlan } from '../../../shared/types';

export function cloneVisioPlan(plan: VisioDiagramPlan): VisioDiagramPlan {
  return JSON.parse(JSON.stringify(plan)) as VisioDiagramPlan;
}

export function areVisioPlansEqual(left?: VisioDiagramPlan, right?: VisioDiagramPlan) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createNextVisioId(prefix: string, ids: Iterable<string>) {
  const used = new Set(ids);
  let index = 1;
  while (used.has(prefix + '_' + index)) index += 1;
  return prefix + '_' + index;
}

export function removeVisioPlanGroup(plan: VisioDiagramPlan, groupId: string): VisioDiagramPlan {
  return {
    ...plan,
    groups: (plan.groups || []).filter((group) => group.id !== groupId),
    nodes: plan.nodes.map((node) => node.group_id === groupId ? { ...node, group_id: undefined } : node),
  };
}

export function removeVisioPlanNode(plan: VisioDiagramPlan, nodeId: string): VisioDiagramPlan {
  return {
    ...plan,
    nodes: plan.nodes.filter((node) => node.id !== nodeId),
    edges: plan.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  };
}

export function normalizeVisioPlanDraft(plan: VisioDiagramPlan): VisioDiagramPlan {
  return {
    ...cloneVisioPlan(plan),
    title: plan.title.trim(),
    page: {
      ...plan.page,
      name: plan.page.name.trim(),
    },
    groups: (plan.groups || []).map((group) => ({
      ...group,
      title: group.title.trim(),
    })),
    nodes: plan.nodes.map((node) => ({
      ...node,
      text: node.text.trim(),
      kind: node.kind.trim(),
    })),
    edges: plan.edges.map((edge) => {
      const label = edge.label?.trim();
      return {
        ...edge,
        ...(label ? { label } : { label: undefined }),
      };
    }),
  };
}

export function validateVisioPlanDraft(plan: VisioDiagramPlan): string[] {
  const errors: string[] = [];
  const groups = plan.groups || [];
  const groupIds = new Set(groups.map((group) => group.id));
  const nodeIds = new Set(plan.nodes.map((node) => node.id));

  if (!plan.title.trim()) errors.push('请填写图表标题');
  if (!plan.page.name.trim()) errors.push('请填写页面名称');
  if (plan.nodes.length === 0) errors.push('图表计划至少需要一个节点');

  groups.forEach((group, index) => {
    if (!group.title.trim()) errors.push('请填写第 ' + (index + 1) + ' 个分组名称');
  });

  plan.nodes.forEach((node, index) => {
    if (!node.text.trim()) errors.push('请填写第 ' + (index + 1) + ' 个节点内容');
    if (!node.kind.trim()) errors.push('请填写第 ' + (index + 1) + ' 个节点类型');
    if (node.group_id && !groupIds.has(node.group_id)) {
      errors.push('节点“' + (node.text.trim() || node.id) + '”引用的分组不存在');
    }
  });

  plan.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.from)) errors.push('第 ' + (index + 1) + ' 条连线的起点不存在');
    if (!nodeIds.has(edge.to)) errors.push('第 ' + (index + 1) + ' 条连线的终点不存在');
  });

  return Array.from(new Set(errors));
}

export function buildVisioPreviewAssetUrl(relativePath: string) {
  const encodedPath = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return encodedPath ? 'yibiao-asset://visio-diagram/' + encodedPath : '';
}
