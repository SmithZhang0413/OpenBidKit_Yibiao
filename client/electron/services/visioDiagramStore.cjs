const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getVisioDiagramDir, getVisioDiagramRevisionsDir } = require('../utils/paths.cjs');

const initialRequirements = {
  title: '',
  requirementText: '',
  diagramTypeMode: 'auto',
  diagramType: undefined,
  pageOrientation: 'portrait',
};

const initialState = {
  step: 'requirements',
  requirements: initialRequirements,
  plan: undefined,
  planRevision: 0,
  activeArtifact: undefined,
  planTask: undefined,
  renderTask: undefined,
};

const taskTypes = {
  planTask: 'visio-plan-generation',
  renderTask: 'visio-rendering',
};

function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function normalizeRequirements(value) {
  return { ...initialRequirements, ...(value || {}) };
}

function normalizeStep(value) {
  return ['requirements', 'plan', 'result'].includes(value) ? value : 'requirements';
}

function createVisioDiagramStore({ app, db }) {
  const diagramDir = getVisioDiagramDir(app);
  const revisionsDir = getVisioDiagramRevisionsDir(app);

  function ensureDirectories() {
    fs.mkdirSync(revisionsDir, { recursive: true });
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM visio_diagram_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO visio_diagram_meta (
        id, step, requirements_json, plan_revision, created_at, updated_at
      ) VALUES (1, 'requirements', @requirements_json, 0, @timestamp, @timestamp)
    `).run({
      requirements_json: JSON.stringify(initialRequirements),
      timestamp,
    });
    return db.prepare('SELECT * FROM visio_diagram_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE visio_diagram_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function loadTask(type) {
    const row = db.prepare('SELECT * FROM visio_diagram_tasks WHERE type = ?').get(type);
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: row.status,
      progress: Number(row.progress || 0),
      logs: safeJsonParse(row.logs_json, []),
      stats: safeJsonParse(row.stats_json, undefined),
      error: row.error || undefined,
      started_at: row.started_at,
      updated_at: row.updated_at,
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM visio_diagram_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO visio_diagram_tasks (
        type, task_id, status, progress, logs_json, stats_json, error, started_at, updated_at
      ) VALUES (
        @type, @task_id, @status, @progress, @logs_json, @stats_json, @error, @started_at, @updated_at
      ) ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        logs_json = excluded.logs_json,
        stats_json = excluded.stats_json,
        error = excluded.error,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: task.task_id || crypto.randomUUID(),
      status: task.status || 'running',
      progress: Number(task.progress || 0),
      logs_json: jsonOrNull(task.logs || []),
      stats_json: jsonOrNull(task.stats),
      error: task.error || null,
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
  }

  function loadVisioDiagram() {
    const meta = ensureMetaRow();
    return {
      ...initialState,
      step: normalizeStep(meta.step),
      requirements: normalizeRequirements(safeJsonParse(meta.requirements_json, initialRequirements)),
      plan: safeJsonParse(meta.plan_json, undefined),
      planRevision: Number(meta.plan_revision || 0),
      activeArtifact: safeJsonParse(meta.active_artifact_json, undefined),
      planTask: loadTask(taskTypes.planTask),
      renderTask: loadTask(taskTypes.renderTask),
    };
  }

  const updateTransaction = db.transaction((partial) => {
    const fields = {};
    if (hasOwn(partial, 'step')) fields.step = normalizeStep(partial.step);
    if (hasOwn(partial, 'requirements')) fields.requirements_json = JSON.stringify(normalizeRequirements(partial.requirements));
    if (hasOwn(partial, 'plan')) fields.plan_json = jsonOrNull(partial.plan);
    if (hasOwn(partial, 'planRevision')) fields.plan_revision = Number(partial.planRevision || 0);
    if (hasOwn(partial, 'activeArtifact')) fields.active_artifact_json = jsonOrNull(partial.activeArtifact);
    updateMeta(fields);
    for (const [field, type] of Object.entries(taskTypes)) {
      if (hasOwn(partial, field)) saveTask(type, partial[field]);
    }
  });

  function updateVisioDiagram(partial) {
    updateTransaction(partial || {});
    return loadVisioDiagram();
  }

  function saveVisioDiagram(state) {
    return updateVisioDiagram(state || {});
  }

  function saveRequirements(requirements) {
    const transaction = db.transaction(() => {
      updateMeta({
        step: 'requirements',
        requirements_json: JSON.stringify(normalizeRequirements(requirements)),
        plan_json: null,
        plan_revision: 0,
        active_artifact_json: null,
      });
      db.prepare('DELETE FROM visio_diagram_tasks').run();
    });
    transaction();
    return loadVisioDiagram();
  }

  function savePlan(plan) {
    const state = loadVisioDiagram();
    return updateVisioDiagram({
      step: 'plan',
      plan,
      planRevision: state.planRevision + 1,
      activeArtifact: undefined,
      renderTask: undefined,
    });
  }

  function allocateArtifactDirectory(planRevision, taskId) {
    ensureDirectories();
    const revision = String(Number(planRevision || 0)).padStart(6, '0');
    const safeTaskId = String(taskId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(revisionsDir, `${revision}-${safeTaskId}`);
  }

  function toRelativeArtifactPath(absolutePath) {
    const resolved = path.resolve(String(absolutePath || ''));
    const relative = path.relative(diagramDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Visio 产物不在工作区目录中：${resolved}`);
    }
    return relative.split(path.sep).join('/');
  }

  function resolveArtifactPath(relativePath) {
    const resolved = path.resolve(diagramDir, String(relativePath || ''));
    const relative = path.relative(diagramDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Visio 产物路径无效');
    }
    return resolved;
  }

  function publishArtifact(result, { planRevision, taskId } = {}) {
    const artifact = {
      artifactRevision: String(taskId || path.basename(result.output_dir)),
      planRevision: Number(planRevision || 0),
      generatedAt: result.manifest?.generated_at || now(),
      outputDir: toRelativeArtifactPath(result.output_dir),
      documentPath: toRelativeArtifactPath(result.document_path),
      planPath: toRelativeArtifactPath(result.plan_path),
      manifestPath: toRelativeArtifactPath(result.manifest_path),
      previewPaths: (result.preview_paths || []).map(toRelativeArtifactPath),
      manifest: result.manifest,
    };
    return updateVisioDiagram({ step: 'result', activeArtifact: artifact });
  }

  function clearVisioDiagram() {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM visio_diagram_tasks').run();
      db.prepare('DELETE FROM visio_diagram_meta').run();
      ensureMetaRow();
    });
    transaction();
    if (fs.existsSync(diagramDir)) {
      fs.rmSync(diagramDir, { recursive: true, force: true });
    }
    ensureDirectories();
    return { success: true, message: 'Visio 图表缓存已清空', state: loadVisioDiagram() };
  }

  ensureDirectories();

  return {
    loadVisioDiagram,
    saveVisioDiagram,
    updateVisioDiagram,
    saveRequirements,
    savePlan,
    allocateArtifactDirectory,
    publishArtifact,
    resolveArtifactPath,
    clearVisioDiagram,
  };
}

module.exports = {
  createVisioDiagramStore,
  initialRequirements,
};