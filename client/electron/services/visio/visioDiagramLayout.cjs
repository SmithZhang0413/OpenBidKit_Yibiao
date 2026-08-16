const PAGE_SIZES = Object.freeze({
  portrait: { width: 8.27, height: 11.69 },
  landscape: { width: 11.69, height: 8.27 },
});

const HORIZONTAL_TYPES = new Set(['block_diagram', 'data_flow_diagram', 'network_diagram']);
const DEFAULT_NODE_WIDTH = 1.8;
const DEFAULT_NODE_HEIGHT = 0.8;
const PAGE_MARGIN = 1;

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

function compareNodeOrder(left, right, nodeIndex) {
  return (nodeIndex.get(left) || 0) - (nodeIndex.get(right) || 0) || left.localeCompare(right);
}

function calculateLayers(plan) {
  const nodeIndex = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(plan.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(plan.nodes.map((node) => [node.id, []]));
  plan.edges.forEach((edge) => {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  });

  const queue = plan.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort((left, right) => compareNodeOrder(left, right, nodeIndex));
  const layers = new Map(plan.nodes.map((node) => [node.id, 0]));
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    visited.add(current);
    const nextNodes = outgoing.get(current) || [];
    nextNodes.forEach((next) => {
      layers.set(next, Math.max(layers.get(next) || 0, (layers.get(current) || 0) + 1));
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort((left, right) => compareNodeOrder(left, right, nodeIndex));
      }
    });
  }

  let cycleLayer = Math.max(0, ...layers.values());
  plan.nodes.forEach((node) => {
    if (!visited.has(node.id)) {
      cycleLayer += 1;
      layers.set(node.id, cycleLayer);
    }
  });
  return layers;
}

function assignGrid(plan) {
  const horizontal = HORIZONTAL_TYPES.has(plan.diagram_type);
  const layers = calculateLayers(plan);
  const groupOrder = new Map([...plan.groups]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((group, index) => [group.id, index]));
  const occupied = new Set();
  const layerSlots = new Map();

  return plan.nodes.map((node) => {
    let row = Number.isInteger(node.row) ? node.row : undefined;
    let column = Number.isInteger(node.column) ? node.column : undefined;
    const layer = layers.get(node.id) || 0;
    const slot = layerSlots.get(layer) || 0;
    layerSlots.set(layer, slot + 1);

    if (row === undefined) row = horizontal ? slot : layer;
    if (column === undefined) {
      if (plan.diagram_type === 'cross_functional_flowchart' && node.group_id) {
        column = groupOrder.get(node.group_id) || 0;
      } else {
        column = horizontal ? layer : slot;
      }
    }

    while (occupied.has(`${row}:${column}`)) {
      if (horizontal) row += 1;
      else column += 1;
    }
    occupied.add(`${row}:${column}`);
    return { ...node, row, column };
  });
}

function layoutDiagramPlan(plan) {
  const pageSize = PAGE_SIZES[plan.page.orientation] || PAGE_SIZES.landscape;
  const gridNodes = assignGrid(plan);
  const maximumRow = Math.max(0, ...gridNodes.map((node) => node.row));
  const maximumColumn = Math.max(0, ...gridNodes.map((node) => node.column));
  const usableWidth = pageSize.width - (PAGE_MARGIN * 2);
  const usableHeight = pageSize.height - (PAGE_MARGIN * 2);
  const horizontalStep = maximumColumn > 0 ? usableWidth / maximumColumn : 0;
  const verticalStep = maximumRow > 0 ? usableHeight / maximumRow : 0;

  const nodes = gridNodes.map((node) => {
    const width = Number(node.width) || DEFAULT_NODE_WIDTH;
    const height = Number(node.height) || DEFAULT_NODE_HEIGHT;
    return {
      ...node,
      x: roundCoordinate(maximumColumn > 0 ? PAGE_MARGIN + (node.column * horizontalStep) : pageSize.width / 2),
      y: roundCoordinate(maximumRow > 0 ? pageSize.height - PAGE_MARGIN - (node.row * verticalStep) : pageSize.height / 2),
      width,
      height,
      explicit_size: Number.isFinite(node.width) || Number.isFinite(node.height),
    };
  });

  return {
    page: { ...plan.page, ...pageSize, margin: PAGE_MARGIN },
    nodes,
    edges: plan.edges.map((edge) => ({ ...edge })),
  };
}

module.exports = {
  layoutDiagramPlan,
};
