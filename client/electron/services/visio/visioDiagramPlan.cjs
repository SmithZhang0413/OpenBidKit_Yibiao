const Ajv = require('ajv');

const SUPPORTED_DIAGRAM_TYPES = Object.freeze([
  'flowchart',
  'cross_functional_flowchart',
  'org_chart',
  'block_diagram',
  'data_flow_diagram',
  'network_diagram',
]);

const VISIO_DIAGRAM_PLAN_SCHEMA = Object.freeze({
  $id: 'https://openbidkit.local/schemas/visio-diagram-plan-v1.json',
  type: 'object',
  required: ['schema_version', 'title', 'diagram_type', 'page', 'nodes', 'edges'],
  additionalProperties: false,
  properties: {
    schema_version: { const: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    diagram_type: { enum: SUPPORTED_DIAGRAM_TYPES },
    page: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        orientation: { enum: ['portrait', 'landscape'], default: 'landscape' },
      },
    },
    groups: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        required: ['id', 'title'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          order: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 300,
      items: {
        type: 'object',
        required: ['id', 'text', 'kind'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
          text: { type: 'string', minLength: 1, maxLength: 1000 },
          kind: { type: 'string', minLength: 1, maxLength: 100 },
          group_id: { type: 'string', minLength: 1, maxLength: 100 },
          row: { type: 'integer', minimum: 0, maximum: 100 },
          column: { type: 'integer', minimum: 0, maximum: 100 },
          width: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
          height: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
          style_role: { enum: ['primary', 'secondary', 'decision', 'external'] },
        },
      },
    },
    edges: {
      type: 'array',
      maxItems: 600,
      items: {
        type: 'object',
        required: ['id', 'from', 'to'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
          from: { type: 'string', minLength: 1, maxLength: 100 },
          to: { type: 'string', minLength: 1, maxLength: 100 },
          label: { type: 'string', maxLength: 300 },
          kind: { enum: ['normal', 'conditional', 'dependency', 'bidirectional'], default: 'normal' },
        },
      },
    },
    notes: {
      type: 'array',
      default: [],
      items: { type: 'string', maxLength: 1000 },
    },
  },
});

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
const validateSchema = ajv.compile(VISIO_DIAGRAM_PLAN_SCHEMA);

function formatValidationErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('；');
}

function assertUniqueIds(items, label) {
  const ids = new Set();
  items.forEach((item) => {
    if (ids.has(item.id)) throw new Error(`${label} ID 重复：${item.id}`);
    ids.add(item.id);
  });
  return ids;
}

function validateDiagramPlan(input) {
  let plan;
  try {
    plan = JSON.parse(JSON.stringify(input));
  } catch (error) {
    const nextError = new Error('DiagramPlan 必须是可序列化的 JSON 对象', { cause: error });
    nextError.code = 'VISIO_DIAGRAM_PLAN_INVALID';
    throw nextError;
  }

  if (!validateSchema(plan)) {
    const error = new Error(`DiagramPlan 格式不正确：${formatValidationErrors(validateSchema.errors)}`);
    error.code = 'VISIO_DIAGRAM_PLAN_INVALID';
    error.validation_errors = validateSchema.errors;
    throw error;
  }

  try {
    const groupIds = assertUniqueIds(plan.groups, '分组');
    const nodeIds = assertUniqueIds(plan.nodes, '节点');
    assertUniqueIds(plan.edges, '连线');
    plan.nodes.forEach((node) => {
      if (node.group_id && !groupIds.has(node.group_id)) throw new Error(`节点 ${node.id} 引用了不存在的分组：${node.group_id}`);
    });
    plan.edges.forEach((edge) => {
      if (!nodeIds.has(edge.from)) throw new Error(`连线 ${edge.id} 的起点不存在：${edge.from}`);
      if (!nodeIds.has(edge.to)) throw new Error(`连线 ${edge.id} 的终点不存在：${edge.to}`);
    });
  } catch (cause) {
    const error = new Error(`DiagramPlan 关系不正确：${cause.message}`, { cause });
    error.code = 'VISIO_DIAGRAM_PLAN_INVALID';
    throw error;
  }

  return plan;
}

module.exports = {
  SUPPORTED_DIAGRAM_TYPES,
  VISIO_DIAGRAM_PLAN_SCHEMA,
  validateDiagramPlan,
};
