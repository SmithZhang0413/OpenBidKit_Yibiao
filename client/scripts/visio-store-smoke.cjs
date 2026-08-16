const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');
const { createVisioDiagramStore } = require('../electron/services/visioDiagramStore.cjs');

async function run() {
  const root = path.join(os.tmpdir(), `易标-Visio-M03-${crypto.randomUUID()}`);
  const databasePath = path.join(root, 'workspace', 'yibiao.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacy = new Database(databasePath);
  legacy.pragma('user_version = 19');
  legacy.close();

  const callbacks = [];
  const fakeApp = {
    getPath(name) {
      assert.equal(name, 'userData');
      return root;
    },
    once(event, callback) {
      callbacks.push({ event, callback });
    },
  };

  let sqlite;
  try {
    sqlite = createSqliteDatabase(fakeApp);
    assert.equal(schemaVersion, 20);
    assert.equal(sqlite.db.pragma('user_version', { simple: true }), 20);
    const tables = new Set(sqlite.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(tables.has('visio_diagram_meta'), true);
    assert.equal(tables.has('visio_diagram_tasks'), true);

    const store = createVisioDiagramStore({ app: fakeApp, db: sqlite.db });
    assert.equal(store.loadVisioDiagram().step, 'requirements');
    store.saveRequirements({
      title: '中文投标审批流程',
      requirementText: '收到文件后复核，通过后提交。',
      diagramTypeMode: 'manual',
      diagramType: 'flowchart',
      pageOrientation: 'landscape',
    });
    const plan = {
      schema_version: 1,
      title: '中文投标审批流程',
      diagram_type: 'flowchart',
      page: { orientation: 'landscape' },
      nodes: [{ id: 'start', label: '开始', kind: 'terminator' }],
      edges: [],
    };
    let state = store.savePlan(plan);
    assert.equal(state.planRevision, 1);
    assert.deepEqual(state.plan, plan);

    state = store.updateVisioDiagram({
      renderTask: {
        task_id: 'render-中文-01',
        status: 'running',
        progress: 40,
        logs: ['正在绘图'],
        stats: { stage: 'shapes' },
        started_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:01.000Z',
      },
    });
    assert.equal(state.renderTask.type, 'visio-rendering');

    const outputDir = store.allocateArtifactDirectory(state.planRevision, 'render-中文-01');
    fs.mkdirSync(outputDir, { recursive: true });
    const names = ['diagram.vsdx', 'plan.json', 'manifest.json', 'preview-01.png'];
    const files = Object.fromEntries(names.map((name) => [name, path.join(outputDir, name)]));
    for (const file of Object.values(files)) fs.writeFileSync(file, 'data', 'utf8');

    state = store.publishArtifact({
      output_dir: outputDir,
      document_path: files['diagram.vsdx'],
      plan_path: files['plan.json'],
      manifest_path: files['manifest.json'],
      preview_paths: [files['preview-01.png']],
      manifest: { generated_at: '2026-08-16T00:00:02.000Z', title: plan.title },
    }, { planRevision: state.planRevision, taskId: 'render-中文-01' });
    assert.equal(state.step, 'result');
    assert.equal(path.isAbsolute(state.activeArtifact.documentPath), false);
    assert.equal(store.resolveArtifactPath(state.activeArtifact.documentPath), files['diagram.vsdx']);
    assert.throws(() => store.resolveArtifactPath('../outside.vsdx'), /路径无效/);

    const reopened = createVisioDiagramStore({ app: fakeApp, db: sqlite.db });
    assert.equal(reopened.loadVisioDiagram().requirements.title, '中文投标审批流程');
    state = reopened.savePlan({ ...plan, title: '修订后的流程' });
    assert.equal(state.planRevision, 2);
    assert.equal(state.activeArtifact, undefined);
    assert.equal(state.renderTask, undefined);
    assert.equal(fs.existsSync(outputDir), true);

    const cleared = reopened.clearVisioDiagram();
    assert.equal(cleared.state.planRevision, 0);
    assert.equal(fs.existsSync(outputDir), false);
    assert.equal(callbacks.some((item) => item.event === 'before-quit'), true);
    console.log('[visio-store-smoke] SQLite v19→v20、状态恢复、修订失效和中文路径产物管理通过。');
  } finally {
    sqlite?.close();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
}

function exit(code) {
  if (app?.isReady?.()) app.exit(code);
  else process.exit(code);
}

app.whenReady().then(run).then(
  () => exit(0),
  (error) => {
    console.error(error?.stack || error?.message || String(error));
    exit(1);
  },
);