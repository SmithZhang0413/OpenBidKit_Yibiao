import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVisioPreviewAssetUrl,
  createNextVisioId,
  normalizeVisioPlanDraft,
  removeVisioPlanGroup,
  removeVisioPlanNode,
  validateVisioPlanDraft,
} from './visioPlanDraft.ts';

function createPlan() {
  return {
    schema_version: 1,
    title: ' 审批流程 ',
    diagram_type: 'cross_functional_flowchart',
    page: { name: ' 第 1 页 ', orientation: 'landscape' },
    groups: [
      { id: 'group_1', title: ' 业务组 ', order: 0 },
      { id: 'group_2', title: ' 技术组 ', order: 1 },
    ],
    nodes: [
      { id: 'node_1', text: ' 提交 ', kind: ' process ', group_id: 'group_1' },
      { id: 'node_2', text: ' 审核 ', kind: 'decision', group_id: 'group_2' },
      { id: 'node_3', text: ' 完成 ', kind: 'process' },
    ],
    edges: [
      { id: 'edge_1', from: 'node_1', to: 'node_2', label: ' 同意 ' },
      { id: 'edge_2', from: 'node_2', to: 'node_3' },
      { id: 'edge_3', from: 'node_3', to: 'node_1' },
    ],
  };
}

test('program-owned IDs choose the first unused sequence number', () => {
  assert.equal(createNextVisioId('node', ['node_1', 'node_3']), 'node_2');
});

test('removing a group clears node ownership without deleting nodes', () => {
  const result = removeVisioPlanGroup(createPlan(), 'group_1');
  assert.deepEqual(result.groups.map((group) => group.id), ['group_2']);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].group_id, undefined);
});

test('removing a node cascades to incoming and outgoing edges', () => {
  const result = removeVisioPlanNode(createPlan(), 'node_1');
  assert.deepEqual(result.nodes.map((node) => node.id), ['node_2', 'node_3']);
  assert.deepEqual(result.edges.map((edge) => edge.id), ['edge_2']);
});

test('normalization trims editable text and validation stays at the input boundary', () => {
  const normalized = normalizeVisioPlanDraft(createPlan());
  assert.equal(normalized.title, '审批流程');
  assert.equal(normalized.page.name, '第 1 页');
  assert.equal(normalized.groups[0].title, '业务组');
  assert.equal(normalized.nodes[0].kind, 'process');
  assert.equal(normalized.edges[0].label, '同意');
  assert.deepEqual(validateVisioPlanDraft(normalized), []);

  normalized.nodes[0].text = ' ';
  normalized.edges[0].from = 'missing';
  assert.deepEqual(validateVisioPlanDraft(normalized), [
    '请填写第 1 个节点内容',
    '第 1 条连线的起点不存在',
  ]);
});

test('preview paths encode each Chinese and whitespace-containing segment', () => {
  assert.equal(
    buildVisioPreviewAssetUrl('中文 项目\\预览 第1页.png'),
    'yibiao-asset://visio-diagram/%E4%B8%AD%E6%96%87%20%E9%A1%B9%E7%9B%AE/%E9%A2%84%E8%A7%88%20%E7%AC%AC1%E9%A1%B5.png',
  );
});