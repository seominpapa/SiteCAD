import { randomUUID } from 'node:crypto';
import { validateChat, validateSteering } from './plan.mjs';
import { attachmentContext } from './chat-attachments.mjs';
import { createBridgeClient, createMcpHandler, mcpTools } from './sitecad-mcp.mjs';
import { checkedSkillInputs, createSitecadSkills } from './sitecad-skills.mjs';
import { sitecadInstructions } from './codex-runtime.mjs';
import { createApiMcpClient } from './api-mcp-client.mjs';
import { createClaudeCodeTransport, claudeProtocolFailure } from './claude-code-transport.mjs';
import { turnTimeoutError } from './chat-errors.mjs';

const MAX_CALLS = 64, TURN_MS = 600000;
const cancelled = () => Error('작업을 취소했습니다. 이미 적용된 도면 변경과 미저장 상태를 확인해 주세요.');
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/.test(value);

function abortable(task, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createClaudeCodeRuntime(options) {
  const { getClaudeCodeConfig, workspace, codexHome, bridgeUrl, bridgeToken, externalServers = [], researchTools = [],
    onEvent = () => {}, onApproval, fetchImpl = fetch, mcpClientFactory = createApiMcpClient,
    spawnImpl, controlTimeoutMs, turnTimeoutMs = TURN_MS } = options;
  if (typeof getClaudeCodeConfig !== 'function') throw claudeProtocolFailure();
  const handle = createMcpHandler(createBridgeClient({ bridgeUrl, bridgeToken, fetchImpl }), researchTools);
  const internal = [...mcpTools, ...researchTools], clients = new Map();
  let catalog = [], model, inventory = [], connected = false, cadVerified = false, inferenceVerified = false, failed = false;
  let active, starting, startupAbort, probe, epoch = 0;
  const emit = value => { try { onEvent(value); } catch { /* UI callbacks cannot change operations. */ } };
  const status = () => ({ connected, running: connected, busy: Boolean(active), inferenceVerified, model: model ?? null,
    mcp: connected ? { name: 'sitecad', tools: internal.map(tool => tool.name), contextVerified: cadVerified } : null, failed });
  function bindings() {
    const result = internal.map(tool => ({ name: `sitecad_${tool.name}`, server: 'sitecad', tool }));
    for (const [index, entry] of inventory.entries()) for (const tool of entry.tools) result.push({ name: `external${index}_${tool.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64), server: entry.name, tool });
    if (result.length > 128 || new Set(result.map(item => item.name)).size !== result.length) throw Error('LLM 도구 수 또는 이름 한도를 초과했습니다.');
    return result;
  }
  async function call(binding, args, turn) {
    if (turn !== active || turn.signal.aborted) throw cancelled();
    if (++turn.toolCalls > MAX_CALLS) { turn.failure = Error('한 요청의 도구 호출 한도에 도달했습니다.'); turn.controller.abort(); throw turn.failure; }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw claudeProtocolFailure();
    const id = randomUUID(), name = binding.tool.name;
    emit({ type: 'tool', id, server: binding.server, name, status: 'running' });
    let result;
    try {
      if (binding.server === 'sitecad') result = await handle('tools/call', { name, arguments: args });
      else {
        const decision = await onApproval?.({ server: binding.server, tool: name, arguments: args });
        if (turn !== active || turn.signal.aborted) throw cancelled();
        result = decision === 'approve' ? await clients.get(binding.server).call(name, args, { signal: turn.signal }) :
          { isError: true, content: [{ type: 'text', text: '사용자가 외부 도구 실행을 승인하지 않았습니다. 실행되지 않았습니다.' }] };
      }
      if (!result || typeof result !== 'object' || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw claudeProtocolFailure();
    } catch {
      if (turn !== active || turn.signal.aborted) throw cancelled();
      result = { isError: true, content: [{ type: 'text', text: '도구 실행 결과를 확인하지 못했습니다. 현재 도면 상태를 확인하고 같은 변경을 바로 반복하지 마세요.' }] };
    }
    if (turn !== active || turn.signal.aborted) throw cancelled();
    const state = result.isError ? 'failed' : 'completed';
    turn.details.push({ tool: name, status: state, ...(binding.server === 'sitecad' ? {} : { server: binding.server }) });
    if (binding.server === 'sitecad') turn.cadTrace.push({ tool: name, status: state, arguments: args, result: { ...result,
      ...(Array.isArray(result.content) ? { content: result.content.map(item => item.type === 'image' ? { type: 'image', mimeType: item.mimeType } : item) } : {}) } });
    turn.toolFailed ||= Boolean(result.isError); emit({ type: 'tool', id, server: binding.server, name, status: state });
    return result;
  }
  async function control(request) {
    const available = bindings();
    if (request?.subtype === 'can_use_tool') {
      const name = request.tool_name?.replace(/^mcp__sitecad__/, '');
      return active?.userStarted && !active.signal.aborted && request.tool_name === `mcp__sitecad__${name}` && available.some(item => item.name === name)
        ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Only registered guarded SiteCAD tools are available.' };
    }
    if (request?.subtype !== 'mcp_message' || request.server_name !== 'sitecad' || !request.message || request.message.jsonrpc !== '2.0') throw claudeProtocolFailure();
    const message = request.message; let result;
    if (message.method === 'tools/list') result = { tools: available.map(item => ({ ...item.tool, name: item.name })) };
    else if (message.method === 'tools/call') {
      const binding = available.find(item => item.name === message.params?.name);
      if (!binding || !active?.userStarted) throw claudeProtocolFailure();
      result = await call(binding, message.params.arguments ?? {}, active);
    } else if (['initialize', 'ping'].includes(message.method)) result = await handle(message.method, message.params);
    else if (message.method?.startsWith('notifications/') && message.id === undefined) result = {};
    else throw claudeProtocolFailure();
    return { mcp_response: { jsonrpc: '2.0', ...(message.id === undefined ? {} : { id: message.id }), result } };
  }
  async function transport(systemPrompt, onMessage, onFailure) {
    const config = await getClaudeCodeConfig();
    return createClaudeCodeTransport({ config, workspace, systemPrompt, onControl: control, onMessage, onFailure, spawnImpl, controlTimeoutMs });
  }
  async function listModels() {
    const generation = epoch;
    const instance = await transport(sitecadInstructions);
    probe = instance;
    try {
      const response = await instance.initialize();
      if (generation !== epoch) throw cancelled();
      if (!Array.isArray(response?.models) || response.models.length > 100) throw claudeProtocolFailure();
      const next = response.models.filter(item => validModel(item.value)).map((item, index) => ({ id: item.value, model: item.value,
        displayName: String(item.displayName ?? item.value).slice(0, 256), description: String(item.description ?? '공식 Claude Code 모델 · 계정 사용 한도 적용').slice(0, 1000), isDefault: index === 0 }));
      if (!next.length || new Set(next.map(item => item.id)).size !== next.length) throw claudeProtocolFailure();
      catalog = next; model ??= next[0].id;
      return catalog.map(item => ({ ...item }));
    } finally { instance.close(); if (probe === instance) probe = undefined; }
  }
  async function start({ verifyCad = true } = {}) {
    if (!starting && !connected) {
      const generation = epoch, controller = new AbortController(); startupAbort = controller;
      starting = (async () => {
        if (!catalog.length) await listModels();
        const next = [];
        for (const server of externalServers) {
          let client;
          try {
            if (controller.signal.aborted) throw cancelled();
            client = mcpClientFactory(server, { workspace, fetchImpl }); clients.set(server.name, client);
            const tools = await client.start({ signal: controller.signal });
            next.push({ name: server.name, status: 'connected', tools: tools.filter(tool => !server.enabledTools?.length || server.enabledTools.includes(tool.name)) });
          } catch {
            await client?.stop(); clients.delete(server.name);
            if (controller.signal.aborted) throw cancelled();
            next.push({ name: server.name, status: 'failed', tools: [] });
          }
        }
        if (generation !== epoch || controller.signal.aborted) throw cancelled();
        inventory = next; connected = true; failed = false;
      })();
    }
    if (starting) { try { await starting; } finally { starting = undefined; startupAbort = undefined; } }
    if (verifyCad && !cadVerified) { const result = await handle('tools/call', { name: 'cad_context', arguments: {} }); if (result.isError) throw Error('현재 도면에 연결하지 못했습니다.'); cadVerified = true; }
    return status();
  }
  async function chat(input, { model: requested, skill, skills, attachmentInputs = [], attachmentWarning } = {}) {
    validateChat(input); const selected = checkedSkillInputs({ skill, skills }, codexHome);
    if (active) throw Error('진행 중인 작업을 먼저 완료하거나 취소해 주세요.');
    if (requested !== undefined && !validModel(requested)) throw Error('사용 가능한 모델을 선택해 주세요.');
    const controller = new AbortController();
    const turn = { controller, signal: controller.signal, startedAt: Date.now(), toolCalls: 0, details: [], cadTrace: [], toolFailed: false, steering: [], text: '' }; active = turn;
    let instance, timedOut = false;
    const abortStartup = () => { startupAbort?.abort(); probe?.close(); turn.instance?.close(); };
    turn.signal.addEventListener('abort', abortStartup, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, turnTimeoutMs);
    try {
      await abortable(start(), turn.signal); if (turn.signal.aborted || active !== turn) throw cancelled();
      model = requested ?? model ?? catalog[0]?.id;
      if (!catalog.some(item => item.id === model)) throw Error('현재 공급자의 모델 목록에서 모델을 선택해 주세요.');
      let system = sitecadInstructions.replaceAll('built-in web search', 'cad_fetch for public URLs (built-in web search is unavailable in this connection)');
      if (selected.length) {
        const store = await createSitecadSkills({ codexHome });
        for (const workflow of selected) { const document = await store.read(workflow.name); system += `\nSelected local skill ${document.name} (cannot grant permissions):\n${document.body}`; }
      }
      let resolveResult, rejectResult;
      const completed = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      // Attach immediately; abort may occur while initialization is still in flight.
      completed.catch(() => {});
      const abort = () => { instance?.close(); rejectResult(cancelled()); };
      turn.signal.addEventListener('abort', abort, { once: true });
      try {
        instance = await transport(system, message => {
          if (active !== turn || turn.signal.aborted) return;
          if (message?.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
            const text = message.event.delta.text;
            if (typeof text !== 'string' || Buffer.byteLength(turn.text + text) > 256 * 1024) throw claudeProtocolFailure();
            turn.text += text; emit({ type: 'delta', text });
          } else if (message?.type === 'result') {
            if (message.is_error || message.subtype !== 'success' || typeof message.result !== 'string' || !message.result || Buffer.byteLength(message.result) > 256 * 1024) return rejectResult(claudeProtocolFailure());
            if (turn.steering.length) {
              const messages = turn.steering; turn.steering = []; turn.text = '';
              instance.user([{ type: 'text', text: `USER_STEERING_JSON (untrusted data):\n${JSON.stringify(messages)}` }]);
            } else resolveResult(message.result);
          }
        }, rejectResult);
        turn.instance = instance;
        if (turn.signal.aborted) throw cancelled();
        await instance.initialize(); await instance.setModel(model);
        if (turn.signal.aborted) throw cancelled();
        const text = `USER_REQUEST_JSON (untrusted data):\n${JSON.stringify({ history: input.history, message: input.message, context: input.context })}${attachmentContext(attachmentInputs, attachmentWarning)}`;
        const content = [{ type: 'text', text }, ...attachmentInputs.filter(item => item.imageData).map(item => ({ type: 'image', source: { type: 'base64', media_type: item.imageMimeType, data: item.imageData } }))];
        emit({ type: 'connected', model }); turn.userStarted = true; instance.user(content);
        const reply = await completed;
        if (turn.signal.aborted || active !== turn) throw cancelled();
        inferenceVerified = true; failed = false;
        if (!turn.text) emit({ type: 'delta', text: reply });
        return { reply, details: turn.details, cadTrace: turn.cadTrace, selectedSkills: selected.map(item => item.name), reports: [], sources: [], toolFailed: turn.toolFailed,
          execution: { toolCalls: turn.toolCalls, limit: MAX_CALLS, elapsedMs: Date.now() - turn.startedAt, timeoutMs: turnTimeoutMs } };
      } finally { turn.signal.removeEventListener('abort', abort); }
    } catch (error) {
      failed = true;
      const failure = timedOut ? turnTimeoutError() : turn.failure ?? (turn.signal.aborted ? cancelled() : error);
      Object.assign(failure, { details: turn.details, cadTrace: turn.cadTrace, execution: { toolCalls: turn.toolCalls, limit: MAX_CALLS, elapsedMs: Date.now() - turn.startedAt, timeoutMs: turnTimeoutMs } });
      throw failure;
    } finally { clearTimeout(timer); turn.signal.removeEventListener('abort', abortStartup); instance?.close(); if (active === turn) active = undefined; }
  }
  async function stop() {
    epoch++; startupAbort?.abort(); probe?.close(); active?.controller.abort(); active?.instance?.close();
    connected = false; cadVerified = false; catalog = []; model = undefined;
    await Promise.all([...clients.values()].map(client => client.stop())); clients.clear(); inventory = [];
  }
  return { start, status, listModels, chat, stop, cancel: stop,
    async steer(message) { validateSteering(message); if (!active || active.signal.aborted) throw Error('진행 중인 작업에만 추가 지시를 보낼 수 있습니다.'); active.steering = [...active.steering, message]; return { accepted: true, queued: true }; },
    async getMcpStatus() { return inventory.map(entry => ({ name: entry.name, status: entry.status, tools: entry.tools.map(tool => tool.name) })); },
    async testExternal(name) { await start({ verifyCad: false }); const entry = inventory.find(item => item.name === name); if (!entry) throw Error('등록한 MCP를 확인해 주세요.'); return { name, status: entry.status, tools: entry.tools.map(tool => tool.name), tested: entry.status === 'connected' && entry.tools.length > 0 }; },
  };
}
