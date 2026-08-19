const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { layoutDiagramPlan } = require('./visioDiagramLayout.cjs');
const { validateDiagramPlan } = require('./visioDiagramPlan.cjs');
const { createVisioDiagramRenderer, parseToolJson } = require('./visioDiagramRenderer.cjs');
const { buildBatchConnections, buildBatchShapes, REQUIRED_RENDER_TOOLS } = require('./visioMcpToolAdapter.cjs');

function createPlan() {
  return {
    schema_version: 1,
    title: '中文审批流程',
    diagram_type: 'flowchart',
    page: { name: '审批流程', orientation: 'portrait' },
    groups: [],
    nodes: [
      { id: 'start', text: '开始', kind: 'start', style_role: 'primary' },
      { id: 'review', text: '评审申请', kind: 'process' },
      { id: 'decision', text: '是否通过？', kind: 'decision', style_role: 'decision' },
      { id: 'approved', text: '批准', kind: 'process' },
      { id: 'rejected', text: '退回修改', kind: 'process' },
      { id: 'end', text: '结束', kind: 'end' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'review' },
      { id: 'e2', from: 'review', to: 'decision' },
      { id: 'e3', from: 'decision', to: 'approved', label: '是', kind: 'conditional' },
      { id: 'e4', from: 'decision', to: 'rejected', label: '否', kind: 'conditional' },
      { id: 'e5', from: 'approved', to: 'end' },
      { id: 'e6', from: 'rejected', to: 'end' },
    ],
    notes: [],
  };
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function createFakeVisioService({ failAt = '' } = {}) {
  const calls = [];
  const standard = {
    stencils: [{ file: 'BASFLO_M.VSSX' }],
    shapes: [
      { master: 'Start/End' },
      { master: 'Process' },
      { master: 'Decision' },
    ],
  };

  return {
    calls,
    async listTools() {
      return [...REQUIRED_RENDER_TOOLS, 'set_shape_text'].map((name) => ({ name }));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === failAt) throw new Error(`模拟失败：${name}`);
      if (name === 'create_diagram') {
        return toolResult({ document: { name: 'Drawing1' }, standard });
      }
      if (name === 'batch_draw_shapes') {
        const shapes = JSON.parse(args.shapes);
        return toolResult({
          ref_map: Object.fromEntries(shapes.map((shape, index) => [shape.id, index + 1])),
          shapes,
        });
      }
      if (name === 'batch_connect_shapes') {
        const connections = JSON.parse(args.connections);
        return toolResult(connections.map((_connection, index) => ({ shape_id: index + 100 })));
      }
      if (name === 'save_document_as') {
        await fs.promises.writeFile(args.file_path, 'fake-vsdx', 'utf-8');
        return toolResult({ name: 'diagram.vsdx', file_path: args.file_path });
      }
      if (name === 'list_pages') return toolResult([{ index: 1, name: 'Page-1' }]);
      if (name === 'export_page_as_image') {
        await fs.promises.writeFile(args.output_path, Buffer.from([137, 80, 78, 71]));
        return toolResult({ output_path: args.output_path });
      }
      if (name === 'get_page_summary') return toolResult({ shape_count: 12, connection_count: 6 });
      return toolResult({ success: true });
    },
  };
}

test('DiagramPlan validation applies defaults and rejects broken references', () => {
  const valid = validateDiagramPlan(createPlan());
  assert.equal(valid.schema_version, 1);
  assert.deepEqual(valid.groups, []);

  const invalid = createPlan();
  invalid.edges[0].from = 'missing';
  assert.throws(
    () => validateDiagramPlan(invalid),
    (error) => error.code === 'VISIO_DIAGRAM_PLAN_INVALID' && error.message.includes('起点不存在'),
  );
});

test('parseToolJson unwraps FastMCP structured result strings', () => {
  const parsed = parseToolJson({ structuredContent: { result: '{"success":true}' } }, 'wrapped');
  assert.deepEqual(parsed, { success: true });
});

test('parseToolJson rejects visio-mcp soft errors', () => {
  assert.throws(
    () => parseToolJson({ structuredContent: { result: '{"error":"COM 调用失败"}' } }, 'soft_error'),
    (error) => error.code === 'VISIO_MCP_TOOL_ERROR' && error.message.includes('COM 调用失败'),
  );
});

test('layoutDiagramPlan produces deterministic branching positions', () => {
  const plan = validateDiagramPlan(createPlan());
  const first = layoutDiagramPlan(plan);
  const second = layoutDiagramPlan(plan);
  assert.deepEqual(first, second);

  const start = first.nodes.find((node) => node.id === 'start');
  const review = first.nodes.find((node) => node.id === 'review');
  const approved = first.nodes.find((node) => node.id === 'approved');
  const rejected = first.nodes.find((node) => node.id === 'rejected');
  assert.ok(start.y > review.y);
  assert.equal(approved.row, rejected.row);
  assert.notEqual(approved.column, rejected.column);
});

test('org chart uses deterministic geometric nodes instead of Office add-on smart shapes', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'testing', 'sample-org-chart-plan.json'), 'utf-8'));
  const plan = validateDiagramPlan(fixture);
  const shapes = buildBatchShapes(plan, layoutDiagramPlan(plan), {});

  assert.equal(shapes.length, plan.nodes.length);
  assert.ok(shapes.every((shape) => shape.type === 'rectangle'));
  assert.ok(shapes.every((shape) => !('master_name' in shape) && !('stencil_name' in shape)));
  assert.equal(shapes[0].fill_color, 'RGB(221,235,247)');
  assert.equal(shapes[1].fill_color, 'RGB(242,242,242)');

  const connections = buildBatchConnections(plan);
  assert.ok(connections.every((connection) => connection.connector_master === 'Dynamic connector'));
  assert.ok(connections.every((connection) => connection.connector_stencil === 'BASFLO_M.VSSX'));

  const bidirectional = buildBatchConnections({
    ...plan,
    edges: [{ id: 'bidirectional', from: plan.nodes[0].id, to: plan.nodes[1].id, kind: 'bidirectional' }],
  });
  assert.equal(bidirectional[0].connector_master, 'Dynamic connector');
});

test('renderer creates a complete version directory and connector labels', async (context) => {
  const baseDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yibiao-visio-中文-'));
  context.after(() => fs.promises.rm(baseDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(baseDirectory, 'revision-0001');
  const service = createFakeVisioService();
  const renderer = createVisioDiagramRenderer({ visioMcpService: service });

  const result = await renderer.render(createPlan(), { outputDir: outputDirectory });
  assert.equal(result.manifest.node_count, 6);
  assert.equal(result.manifest.edge_count, 6);
  assert.equal(result.preview_paths.length, 1);
  assert.equal((await fs.promises.stat(result.document_path)).size, 9);
  assert.equal((await fs.promises.stat(result.preview_paths[0])).size, 4);

  const saveCall = service.calls.find((call) => call.name === 'save_document_as');
  assert.match(path.basename(saveCall.args.file_path), /^diagram-[0-9a-f-]{36}\.vsdx$/);
  const drawCall = service.calls.find((call) => call.name === 'batch_draw_shapes');
  const connectCall = service.calls.find((call) => call.name === 'batch_connect_shapes');
  assert.equal(typeof drawCall.args.shapes, 'string');
  assert.equal(typeof connectCall.args.connections, 'string');
  assert.equal(typeof connectCall.args.ref_map, 'string');
  assert.equal(service.calls.filter((call) => call.name === 'set_shape_text').length, 2);
  assert.equal(service.calls.at(-1).name, 'close_document');
  assert.equal(service.calls.at(-1).args.doc_name, 'diagram.vsdx');
});

test('renderer removes temporary output when rendering fails', async (context) => {
  const baseDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yibiao-visio-failure-'));
  context.after(() => fs.promises.rm(baseDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(baseDirectory, 'revision-0002');
  const service = createFakeVisioService({ failAt: 'export_page_as_image' });
  const renderer = createVisioDiagramRenderer({ visioMcpService: service });

  await assert.rejects(renderer.render(createPlan(), { outputDir: outputDirectory }), /模拟失败/);
  assert.equal(fs.existsSync(outputDirectory), false);
  const leftovers = (await fs.promises.readdir(baseDirectory)).filter((name) => name.startsWith('revision-0002.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(service.calls.at(-1).name, 'close_document');
  assert.equal(service.calls.at(-1).args.doc_name, 'diagram.vsdx');
});

test('renderer closes a recovery document by its post-SaveAs name', async (context) => {
  const baseDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yibiao-visio-recovery-name-'));
  context.after(() => fs.promises.rm(baseDirectory, { recursive: true, force: true }));
  const service = createFakeVisioService({ failAt: 'batch_connect_shapes' });
  const renderer = createVisioDiagramRenderer({ visioMcpService: service });

  await assert.rejects(
    renderer.render(createPlan(), { outputDir: path.join(baseDirectory, 'revision-0003') }),
    /模拟失败/,
  );

  const closeCall = service.calls.find((call) => call.name === 'close_document');
  assert.equal(closeCall.args.doc_name, 'diagram.vsdx');
});
