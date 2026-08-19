const REQUIRED_RENDER_TOOLS = Object.freeze([
  'create_diagram',
  'batch_draw_shapes',
  'batch_connect_shapes',
  'save_document_as',
  'list_pages',
  'export_page_as_image',
  'get_page_summary',
  'close_document',
]);

const SIMPLE_STYLE_TYPES = new Set([
  'flowchart',
  'cross_functional_flowchart',
  'block_diagram',
  'data_flow_diagram',
]);

const STYLE_PALETTE = Object.freeze({
  primary: {
    fill_color: 'RGB(221,235,247)',
    line_color: 'RGB(68,114,196)',
    line_weight: '1.25 pt',
  },
  secondary: {
    fill_color: 'RGB(242,242,242)',
    line_color: 'RGB(127,127,127)',
  },
  decision: {
    fill_color: 'RGB(255,242,204)',
    line_color: 'RGB(191,143,0)',
  },
  external: {
    fill_color: 'RGB(226,239,218)',
    line_color: 'RGB(84,130,53)',
  },
});

const ORG_CHART_PRIMARY_KINDS = new Set(['executive', 'manager']);

const DIAGRAM_PROFILES = Object.freeze({
  flowchart: {
    defaultShape: ['Process', 'BASFLO_M.VSSX'],
    shapes: {
      start: ['Start/End', 'BASFLO_M.VSSX'],
      end: ['Start/End', 'BASFLO_M.VSSX'],
      process: ['Process', 'BASFLO_M.VSSX'],
      decision: ['Decision', 'BASFLO_M.VSSX'],
      subprocess: ['Subprocess', 'BASFLO_M.VSSX'],
      document: ['Document', 'BASFLO_M.VSSX'],
      data: ['Data', 'BASFLO_M.VSSX'],
      database: ['Database', 'BASFLO_M.VSSX'],
      external_data: ['External Data', 'BASFLO_M.VSSX'],
    },
  },
  cross_functional_flowchart: {
    defaultShape: ['Process', 'BASFLO_M.VSSX'],
    shapes: {
      start: ['Start/End', 'BASFLO_M.VSSX'],
      end: ['Start/End', 'BASFLO_M.VSSX'],
      process: ['Process', 'BASFLO_M.VSSX'],
      decision: ['Decision', 'BASFLO_M.VSSX'],
      subprocess: ['Subprocess', 'BASFLO_M.VSSX'],
      document: ['Document', 'BASFLO_M.VSSX'],
      data: ['Data', 'BASFLO_M.VSSX'],
    },
  },
  org_chart: {
    defaultShape: ['Position', 'ORGCH_M.VSSX'],
    shapes: {
      executive: ['Executive', 'ORGCH_M.VSSX'],
      manager: ['Manager', 'ORGCH_M.VSSX'],
      position: ['Position', 'ORGCH_M.VSSX'],
      consultant: ['Consultant', 'ORGCH_M.VSSX'],
      vacancy: ['Vacancy', 'ORGCH_M.VSSX'],
      assistant: ['Assistant', 'ORGCH_M.VSSX'],
      staff: ['Staff', 'ORGCH_M.VSSX'],
    },
    defaultConnector: ['Dynamic connector', 'BASFLO_M.VSSX'],
    dependencyConnector: ['Dotted line', 'BLOCK_M.VSSX'],
  },
  block_diagram: {
    defaultShape: ['Box', 'BLOCK_M.VSSX'],
    shapes: {
      box: ['Box', 'BLOCK_M.VSSX'],
      component: ['Box', 'BLOCK_M.VSSX'],
      service: ['Auto-height box', 'BLOCK_M.VSSX'],
      circle: ['Circle', 'BLOCK_M.VSSX'],
      decision: ['Diamond', 'BLOCK_M.VSSX'],
      layered: ['Layered Box', 'BLOCK_M.VSSX'],
    },
    dependencyConnector: ['Dotted line', 'BLOCK_M.VSSX'],
    bidirectionalConnector: ['Double arrowhead', 'BLOCK_M.VSSX'],
  },
  data_flow_diagram: {
    defaultShape: ['Data process', 'DATFLO_M.VSSX'],
    shapes: {
      process: ['Data process', 'DATFLO_M.VSSX'],
      external: ['External interactor', 'DATFLO_M.VSSX'],
      external_entity: ['External interactor', 'DATFLO_M.VSSX'],
      data_store: ['Data store', 'DATFLO_M.VSSX'],
      object: ['Object', 'DATFLO_M.VSSX'],
      multiple_process: ['Multiple process', 'DATFLO_M.VSSX'],
    },
  },
  network_diagram: {
    defaultShape: ['Server', 'PERIPH_M.VSSX'],
    shapes: {
      server: ['Server', 'PERIPH_M.VSSX'],
      router: ['Router', 'PERIPH_M.VSSX'],
      switch: ['Switch', 'PERIPH_M.VSSX'],
      firewall: ['Firewall', 'PERIPH_M.VSSX'],
      hub: ['Hub', 'PERIPH_M.VSSX'],
      bridge: ['Bridge', 'PERIPH_M.VSSX'],
      modem: ['Modem', 'PERIPH_M.VSSX'],
      access_point: ['Wireless access point', 'PERIPH_M.VSSX'],
      user: ['User', 'PERIPH_M.VSSX'],
      printer: ['Printer', 'PERIPH_M.VSSX'],
      cloud: ['Cloud', 'NETLOC_M.VSSX'],
      building: ['Building', 'NETLOC_M.VSSX'],
      data_center: ['Data Center', 'NETLME_M.VSSX'],
    },
  },
});

function normalizeKind(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function canonicalMasterName(standard, requested) {
  const match = (standard?.shapes || []).find((shape) => String(shape.master).toLowerCase() === String(requested).toLowerCase());
  return match?.master || requested;
}

function resolveNodeMaster(diagramType, standard, kind) {
  const profile = DIAGRAM_PROFILES[diagramType];
  if (!profile) throw new Error(`尚未实现图表类型映射：${diagramType}`);
  const [master, stencil] = profile.shapes[normalizeKind(kind)] || profile.defaultShape;
  return { master_name: canonicalMasterName(standard, master), stencil_name: stencil };
}

function resolveConnector(diagramType, edge) {
  const profile = DIAGRAM_PROFILES[diagramType];
  let connector = profile?.defaultConnector;
  if (edge.kind === 'dependency' && profile?.dependencyConnector) connector = profile.dependencyConnector;
  if (edge.kind === 'bidirectional' && profile?.bidirectionalConnector) connector = profile.bidirectionalConnector;
  if (!connector) return {};
  return { connector_master: connector[0], connector_stencil: connector[1] };
}

function buildBatchShapes(plan, layout, standard) {
  return layout.nodes.map((node) => {
    if (plan.diagram_type === 'org_chart') {
      // Office 15 的 OrgC11 加载项会异步替换组织结构图智能 Master，COM 无法稳定持有返回对象。
      // 使用原生几何节点和显式连接线，保持 VSDX 可编辑，同时让 Renderer 行为可确定。
      const role = node.style_role || (ORG_CHART_PRIMARY_KINDS.has(normalizeKind(node.kind)) ? 'primary' : 'secondary');
      return {
        id: node.id,
        type: 'rectangle',
        x1: node.x - (node.width / 2),
        y1: node.y - (node.height / 2),
        x2: node.x + (node.width / 2),
        y2: node.y + (node.height / 2),
        text: node.text,
        ...(STYLE_PALETTE[role] || STYLE_PALETTE.secondary),
      };
    }
    const master = resolveNodeMaster(plan.diagram_type, standard, node.kind);
    const shape = {
      id: node.id,
      type: 'drop',
      ...master,
      x: node.x,
      y: node.y,
      text: node.text,
    };
    if (SIMPLE_STYLE_TYPES.has(plan.diagram_type) || node.explicit_size) {
      shape.width = node.width;
      shape.height = node.height;
    }
    if (SIMPLE_STYLE_TYPES.has(plan.diagram_type) && node.style_role) {
      Object.assign(shape, STYLE_PALETTE[node.style_role] || {});
    }
    return shape;
  });
}

function buildBatchConnections(plan) {
  return plan.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...resolveConnector(plan.diagram_type, edge),
  }));
}

function assertRenderTools(toolDefinitions, { needsConnectorLabels = false } = {}) {
  const available = new Set(toolDefinitions.map((tool) => tool.name));
  const required = needsConnectorLabels ? [...REQUIRED_RENDER_TOOLS, 'set_shape_text'] : [...REQUIRED_RENDER_TOOLS];
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) {
    const error = new Error(`Visio MCP 缺少绘图工具：${missing.join('、')}`);
    error.code = 'VISIO_MCP_CAPABILITY_MISSING';
    error.missing_tools = missing;
    throw error;
  }
}

module.exports = {
  REQUIRED_RENDER_TOOLS,
  assertRenderTools,
  buildBatchConnections,
  buildBatchShapes,
  resolveConnector,
  resolveNodeMaster,
};
