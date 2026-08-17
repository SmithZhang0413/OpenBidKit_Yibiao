const { resolveVisioMcpRuntime } = require('./visioMcpRuntime.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_NAME = 'yibiao-visio-mcp';

async function loadMcpSdk() {
  const [clientModule, stdioModule] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
    getDefaultEnvironment: stdioModule.getDefaultEnvironment,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function compactMessage(value, maximum = 500) {
  const message = String(value || '').replace(/\s+/g, ' ').trim();
  return message.length > maximum ? `${message.slice(0, maximum - 1)}…` : message;
}

function createServiceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createCancellationError(signal) {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : String(reason || 'Visio MCP 调用已取消');
  return createServiceError('VISIO_MCP_CANCELLED', message, reason instanceof Error ? reason : undefined);
}

function describeToolError(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
  return compactMessage(text || 'Visio MCP 工具执行失败');
}

function findDeclaredToolError(result) {
  const texts = (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .filter(Boolean);
  for (const text of texts) {
    try {
      const payload = JSON.parse(text);
      if (payload?.error) return compactMessage(payload.error);
    } catch {}
  }
  return '';
}

function publicRuntimeStatus(runtime) {
  if (!runtime) return null;
  return {
    supported: runtime.supported,
    available: runtime.available,
    mode: runtime.mode,
    source: runtime.source,
    reason: runtime.reason,
  };
}

function createVisioMcpService({
  app,
  getRuntimeConfig = () => ({}),
  runtimeResolver = resolveVisioMcpRuntime,
  sdkLoader = loadMcpSdk,
  logger = { write() {} },
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const listeners = new Set();
  let phase = 'stopped';
  let updatedAt = nowIso();
  let lastError = '';
  let runtime = null;
  let client = null;
  let transport = null;
  let toolDefinitions = [];
  let startPromise = null;
  let closePromise = null;
  let serialTail = Promise.resolve();
  let queueGeneration = 0;
  let intentionalClose = false;

  function getStatus() {
    const visibleRuntime = runtime || runtimeResolver({ app, config: getRuntimeConfig() });
    return {
      phase,
      healthy: phase === 'ready',
      message: phase === 'ready' ? 'Visio MCP 已就绪' : lastError || {
        stopped: 'Visio MCP 未启动',
        starting: '正在启动 Visio MCP',
        closing: '正在关闭 Visio MCP',
        faulted: 'Visio MCP 连接异常',
      }[phase] || 'Visio MCP 状态未知',
      updated_at: updatedAt,
      last_error: lastError,
      runtime: publicRuntimeStatus(visibleRuntime),
      server: client ? {
        ...client.getServerVersion?.(),
        tool_count: toolDefinitions.length,
      } : null,
      process_id: transport?.pid || null,
    };
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  function setPhase(nextPhase, error = '') {
    phase = nextPhase;
    lastError = compactMessage(error);
    updatedAt = nowIso();
    logger.write('runtime.phase', { phase, error: lastError });
    emitStatus();
  }

  function clearConnection() {
    client = null;
    transport = null;
    toolDefinitions = [];
  }

  function handleUnexpectedClose() {
    if (intentionalClose || phase === 'closing' || phase === 'stopped') return;
    clearConnection();
    setPhase('faulted', 'Visio MCP 子进程已退出');
  }

  function enqueue(operation, signal) {
    const generation = queueGeneration;
    const run = async () => {
      if (generation !== queueGeneration || signal?.aborted) throw createCancellationError(signal);
      return operation();
    };
    const result = serialTail.then(run, run);
    serialTail = result.catch(() => undefined);
    return result;
  }

  async function collectTools(activeClient, options = {}) {
    const tools = [];
    let cursor;
    do {
      const page = await activeClient.listTools(cursor ? { cursor } : undefined, options);
      tools.push(...(Array.isArray(page?.tools) ? page.tools : []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  async function start() {
    if (phase === 'ready' && client && transport) return getStatus();
    if (startPromise) return startPromise;
    if (closePromise) await closePromise;

    const generation = queueGeneration;
    startPromise = (async () => {
      intentionalClose = false;
      setPhase('starting');
      runtime = runtimeResolver({ app, config: getRuntimeConfig() || {} });
      if (!runtime.supported) throw createServiceError('VISIO_MCP_UNSUPPORTED', runtime.reason);
      if (!runtime.available) throw createServiceError('VISIO_MCP_RUNTIME_NOT_FOUND', runtime.reason);

      const sdk = await sdkLoader();
      const inheritedEnvironment = sdk.getDefaultEnvironment?.() || {};
      const nextTransport = new sdk.StdioClientTransport({
        command: runtime.command,
        args: runtime.args,
        cwd: runtime.cwd || undefined,
        env: { ...inheritedEnvironment, ...runtime.env },
        stderr: 'pipe',
      });
      const nextClient = new sdk.Client({
        name: CLIENT_NAME,
        version: app?.getVersion?.() || '0.0.0',
      }, { capabilities: {} });

      nextClient.onclose = handleUnexpectedClose;
      nextClient.onerror = (error) => {
        lastError = compactMessage(error?.message || error);
        logger.write('transport.error', { error: lastError });
        emitStatus();
      };
      nextTransport.stderr?.on?.('data', (chunk) => {
        logger.write('sidecar.stderr', { message: compactMessage(chunk?.toString?.('utf8') || chunk, 2000) });
      });

      transport = nextTransport;
      client = nextClient;
      await nextClient.connect(nextTransport, { timeout: requestTimeoutMs });
      if (generation !== queueGeneration) throw createCancellationError();
      toolDefinitions = await collectTools(nextClient, { timeout: requestTimeoutMs });
      setPhase('ready');
      logger.write('runtime.ready', {
        server: nextClient.getServerVersion?.() || {},
        tool_names: toolDefinitions.map((tool) => tool.name),
      });
      return getStatus();
    })();

    try {
      return await startPromise;
    } catch (error) {
      const message = error?.message || String(error);
      intentionalClose = true;
      try { await client?.close?.(); } catch {}
      try { await transport?.close?.(); } catch {}
      clearConnection();
      setPhase('faulted', message);
      throw error;
    } finally {
      startPromise = null;
      intentionalClose = false;
    }
  }

  async function listTools({ refresh = false, signal } = {}) {
    return enqueue(async () => {
      await start();
      if (refresh) toolDefinitions = await collectTools(client, { signal, timeout: requestTimeoutMs });
      return toolDefinitions.map((tool) => ({ ...tool }));
    }, signal);
  }

  async function callTool(name, args = {}, { signal, timeoutMs = requestTimeoutMs, onProgress } = {}) {
    const toolName = String(name || '').trim();
    if (!toolName) throw createServiceError('VISIO_MCP_TOOL_REQUIRED', '缺少 Visio MCP 工具名称');

    return enqueue(async () => {
      await start();
      const knownTool = toolDefinitions.some((tool) => tool.name === toolName);
      if (!knownTool) throw createServiceError('VISIO_MCP_TOOL_NOT_FOUND', `Visio MCP 不支持工具：${toolName}`);

      const startedAt = Date.now();
      logger.write('tool.start', { tool: toolName });
      try {
        const result = await client.callTool(
          { name: toolName, arguments: args || {} },
          undefined,
          {
            signal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs,
            resetTimeoutOnProgress: true,
            onprogress: onProgress,
          },
        );
        const declaredError = findDeclaredToolError(result);
        if (result?.isError || declaredError) {
          const error = createServiceError('VISIO_MCP_TOOL_ERROR', declaredError || describeToolError(result));
          error.result = result;
          throw error;
        }
        logger.write('tool.end', { tool: toolName, duration_ms: Date.now() - startedAt });
        return result;
      } catch (error) {
        logger.write('tool.error', {
          tool: toolName,
          duration_ms: Date.now() - startedAt,
          error: compactMessage(error?.message || error),
        });
        throw error;
      }
    }, signal);
  }

  async function runSelfCheck({ signal } = {}) {
    return enqueue(async () => {
      const startedAt = Date.now();
      await start();
      await client.ping({ signal, timeout: requestTimeoutMs });
      toolDefinitions = await collectTools(client, { signal, timeout: requestTimeoutMs });
      return {
        success: true,
        checked_at: nowIso(),
        duration_ms: Date.now() - startedAt,
        server: client.getServerVersion?.() || null,
        tools: toolDefinitions.map((tool) => tool.name),
        runtime: publicRuntimeStatus(runtime),
      };
    }, signal);
  }

  async function close() {
    if (closePromise) return closePromise;
    queueGeneration += 1;
    intentionalClose = true;
    closePromise = (async () => {
      setPhase('closing');
      if (startPromise) await startPromise.catch(() => undefined);
      try { await client?.close?.(); } catch {}
      try { await transport?.close?.(); } catch {}
      clearConnection();
      serialTail = Promise.resolve();
      setPhase('stopped');
    })().finally(() => {
      closePromise = null;
      intentionalClose = false;
    });
    return closePromise;
  }

  async function restart() {
    await close();
    return start();
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    listTools,
    callTool,
    runSelfCheck,
    getStatus,
    restart,
    onStatus,
    close,
  };
}

module.exports = {
  createVisioMcpService,
  loadMcpSdk,
};
