const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateDiagramPlan } = require('./visioDiagramPlan.cjs');
const { layoutDiagramPlan } = require('./visioDiagramLayout.cjs');
const {
  assertRenderTools,
  buildBatchConnections,
  buildBatchShapes,
} = require('./visioMcpToolAdapter.cjs');

function parseToolJson(result, toolName) {
  let payload;
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    const wrapped = result.structuredContent.result;
    if (typeof wrapped === 'string') {
      try { payload = JSON.parse(wrapped); } catch {}
    }
    if (!payload && wrapped && typeof wrapped === 'object') payload = wrapped;
    if (!payload) payload = result.structuredContent;
  }
  if (!payload) {
    const texts = (Array.isArray(result?.content) ? result.content : [])
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .filter(Boolean);
    for (const text of texts) {
      try {
        payload = JSON.parse(text);
        break;
      } catch {}
    }
  }
  if (payload?.error) {
    const error = new Error(`Visio MCP 工具 ${toolName} 执行失败：${payload.error}`);
    error.code = 'VISIO_MCP_TOOL_ERROR';
    throw error;
  }
  if (payload !== undefined) return payload;
  const error = new Error(`Visio MCP 工具 ${toolName} 没有返回可解析的 JSON`);
  error.code = 'VISIO_MCP_RESULT_INVALID';
  throw error;
}
function extractDocumentName(payload) {
  return String(
    payload?.document?.name
    || payload?.document_name
    || payload?.doc_name
    || payload?.name
    || '',
  );
}

function extractStandard(payload) {
  return payload?.standard || payload?.diagram_standard || payload;
}

function normalizePages(payload) {
  const source = Array.isArray(payload) ? payload : payload?.pages;
  if (!Array.isArray(source) || !source.length) {
    const error = new Error('Visio MCP 没有返回有效页面列表');
    error.code = 'VISIO_PAGE_LIST_INVALID';
    throw error;
  }
  return source.map((page, index) => ({
    index: Number(page?.index || page?.number || index + 1),
    name: String(page?.name || page?.page_name || page?.index || index + 1),
  }));
}

function normalizeConnectionResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.connections)) return payload.connections;
  if (Array.isArray(payload?.connectors)) return payload.connectors;
  return [];
}

function connectorShapeId(item) {
  return item?.shape_id ?? item?.connector_id ?? item?.id ?? null;
}

async function assertNonEmptyFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    const error = new Error(`Visio 产物为空：${filePath}`);
    error.code = 'VISIO_ARTIFACT_EMPTY';
    throw error;
  }
  return stat.size;
}

function createVisioDiagramRenderer({ visioMcpService } = {}) {
  if (!visioMcpService) throw new Error('缺少 VisioMcpService');

  async function render(inputPlan, { outputDir, signal, onProgress } = {}) {
    const plan = validateDiagramPlan(inputPlan);
    const targetDirectory = path.resolve(String(outputDir || ''));
    if (!outputDir) throw new Error('缺少 Visio 产物输出目录');
    if (fs.existsSync(targetDirectory)) {
      const error = new Error(`Visio 产物目录已存在：${targetDirectory}`);
      error.code = 'VISIO_OUTPUT_EXISTS';
      throw error;
    }

    const temporaryDirectory = `${targetDirectory}.tmp-${crypto.randomUUID()}`;
    const renderId = crypto.randomUUID();
    const workingDocumentPath = path.join(temporaryDirectory, `diagram-${renderId}.vsdx`);
    const documentPath = path.join(temporaryDirectory, 'diagram.vsdx');
    const planPath = path.join(temporaryDirectory, 'plan.json');
    const manifestPath = path.join(temporaryDirectory, 'manifest.json');
    let documentCreated = false;
    let documentSaved = false;
    let documentName = '';

    const progress = (stage, message, percent) => {
      try { onProgress?.({ stage, message, percent }); } catch {}
    };

    try {
      await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true });
      await fs.promises.mkdir(temporaryDirectory, { recursive: false });
      await fs.promises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

      progress('capability', '正在检查 Visio MCP 绘图能力', 5);
      const tools = await visioMcpService.listTools({ signal });
      assertRenderTools(tools, { needsConnectorLabels: plan.edges.some((edge) => edge.label) });

      progress('document', '正在创建 Visio 图表文档', 12);
      const createResult = await visioMcpService.callTool(
        'create_diagram',
        { diagram_type: plan.diagram_type },
        { signal },
      );
      const createPayload = parseToolJson(createResult, 'create_diagram');
      documentCreated = true;
      documentName = extractDocumentName(createPayload);
      const standard = extractStandard(createPayload);
      const layout = layoutDiagramPlan(plan);
      const shapes = buildBatchShapes(plan, layout, standard);

      progress('shapes', `正在批量绘制 ${shapes.length} 个图形`, 30);
      const drawResult = await visioMcpService.callTool(
        'batch_draw_shapes',
        {
          shapes: JSON.stringify(shapes),
          page: '',
          doc_name: documentName,
        },
        { signal },
      );
      const drawPayload = parseToolJson(drawResult, 'batch_draw_shapes');
      const refMap = drawPayload?.ref_map || {};
      if (Object.keys(refMap).length !== plan.nodes.length) {
        const error = new Error(`Visio 实际创建 ${Object.keys(refMap).length} 个节点，计划要求 ${plan.nodes.length} 个`);
        error.code = 'VISIO_SHAPE_COUNT_MISMATCH';
        throw error;
      }

      const connections = buildBatchConnections(plan);
      let connectionResults = [];
      if (connections.length) {
        progress('connections', `正在批量连接 ${connections.length} 条关系`, 50);
        const connectResult = await visioMcpService.callTool(
          'batch_connect_shapes',
          {
            connections: JSON.stringify(connections),
            ref_map: JSON.stringify(refMap),
            page: '',
            doc_name: documentName,
          },
          { signal },
        );
        connectionResults = normalizeConnectionResults(parseToolJson(connectResult, 'batch_connect_shapes'));
        if (connectionResults.length !== connections.length) {
          const error = new Error(`Visio 实际创建 ${connectionResults.length} 条连接，计划要求 ${connections.length} 条`);
          error.code = 'VISIO_CONNECTION_COUNT_MISMATCH';
          throw error;
        }
      }

      for (let index = 0; index < plan.edges.length; index += 1) {
        const edge = plan.edges[index];
        if (!edge.label) continue;
        const shapeId = connectorShapeId(connectionResults[index]);
        if (shapeId === null) {
          const error = new Error(`无法定位连线 ${edge.id} 的 Visio Shape ID`);
          error.code = 'VISIO_CONNECTOR_ID_MISSING';
          throw error;
        }
        await visioMcpService.callTool('set_shape_text', {
          shape_id: shapeId,
          text: edge.label,
          page: '',
          doc_name: documentName,
        }, { signal });
      }

      progress('save', '正在保存可编辑 Visio 文件', 68);
      const saveResult = await visioMcpService.callTool(
        'save_document_as',
        { file_path: workingDocumentPath, doc_name: documentName },
        { signal },
      );
      const savePayload = parseToolJson(saveResult, 'save_document_as');
      documentName = extractDocumentName(savePayload) || documentName;
      documentSaved = true;
      const documentBytes = await assertNonEmptyFile(workingDocumentPath);

      const pagesResult = await visioMcpService.callTool('list_pages', { doc_name: documentName }, { signal });
      const pages = normalizePages(parseToolJson(pagesResult, 'list_pages'));
      const previews = [];
      const summaries = [];
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const fileName = `preview-${String(index + 1).padStart(2, '0')}.png`;
        const outputPath = path.join(temporaryDirectory, fileName);
        progress('preview', `正在导出第 ${index + 1}/${pages.length} 页预览`, 72 + Math.round(((index + 1) / pages.length) * 18));
        await visioMcpService.callTool(
          'export_page_as_image',
          { output_path: outputPath, page: page.name, doc_name: documentName },
          { signal },
        );
        previews.push({
          page_index: page.index,
          page_name: page.name,
          file_name: fileName,
          bytes: await assertNonEmptyFile(outputPath),
        });
        const summaryResult = await visioMcpService.callTool(
          'get_page_summary',
          { page: page.name, doc_name: documentName },
          { signal },
        );
        summaries.push(parseToolJson(summaryResult, 'get_page_summary'));
      }

      const manifest = {
        manifest_version: 1,
        generated_at: new Date().toISOString(),
        title: plan.title,
        diagram_type: plan.diagram_type,
        plan_schema_version: plan.schema_version,
        node_count: plan.nodes.length,
        edge_count: plan.edges.length,
        document: { file_name: 'diagram.vsdx', bytes: documentBytes },
        previews,
        page_summaries: summaries,
      };
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      progress('close', '正在完成 Visio 文档', 95);
      await visioMcpService.callTool('close_document', { doc_name: documentName }, { signal });
      documentCreated = false;
      await fs.promises.rename(workingDocumentPath, documentPath);
      await fs.promises.rename(temporaryDirectory, targetDirectory);
      progress('complete', 'Visio 图生成完成', 100);

      return {
        output_dir: targetDirectory,
        document_path: path.join(targetDirectory, 'diagram.vsdx'),
        plan_path: path.join(targetDirectory, 'plan.json'),
        manifest_path: path.join(targetDirectory, 'manifest.json'),
        preview_paths: previews.map((preview) => path.join(targetDirectory, preview.file_name)),
        manifest,
      };
    } catch (error) {
      if (documentCreated) {
        if (!documentSaved) {
          try {
            const failedSaveResult = await visioMcpService.callTool('save_document_as', {
              file_path: path.join(temporaryDirectory, `failed-diagram-${renderId}.vsdx`),
              doc_name: documentName,
            });
            const failedSavePayload = parseToolJson(failedSaveResult, 'save_document_as');
            documentName = extractDocumentName(failedSavePayload) || documentName;
            documentSaved = true;
          } catch {}
        }
        if (documentSaved) {
          try { await visioMcpService.callTool('close_document', { doc_name: documentName }); } catch {}
        }
      }
      try {
        await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        error.cleanup_error = cleanupError?.message || String(cleanupError);
        error.temporary_directory = temporaryDirectory;
      }
      throw error;
    }
  }

  return { render };
}

module.exports = {
  createVisioDiagramRenderer,
  parseToolJson,
};
