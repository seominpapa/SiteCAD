import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpTools } from '../lib/sitecad-mcp.mjs';
import { createCodexRuntime, JsonRpcProcess, runtimeConfig } from '../lib/codex-runtime.mjs';

function fakeChild(onRequest) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); return true; };
  child.stdin = new Writable({ write(chunk, encoding, callback) { const request = JSON.parse(chunk.toString()); callback(); queueMicrotask(() => onRequest(request, message => child.stdout.write(`${JSON.stringify(message)}\n`))); } });
  return child;
}
async function modelRuntime({ list, events = [], holdTurn = false, intercept, runtimeOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-models-'));
  const calls = []; const emitted = []; let starts = 0;
  const runtime = createCodexRuntime({ codexPath: '/app/codex', nodePath: process.execPath, mcpPath: '/app/mcp.mjs', codexHome: join(directory, 'codex'), workspace: join(directory, 'workspace'), bridgeUrl: 'http://127.0.0.1:1234', bridgeToken: 'x'.repeat(32), getAccessToken: async () => 'token', onEvent: event => emitted.push(event), ...runtimeOptions,
    spawnImpl: () => { starts++; return fakeChild((request, send) => {
      if (!request.method || !Object.hasOwn(request, 'id')) return;
      calls.push(request);
      if (intercept?.(request, send)) return;
      let result = {};
      if (request.method === 'model/list') result = list ? list(request.params, starts) : { data: [{ id: 'default', isDefault: true }, { id: 'other' }] };
      if (request.method === 'thread/start') result = { thread: { id: request.params.ephemeral ? 'probe' : 'persistent' } };
      if (request.method === 'thread/resume') result = { thread: { id: request.params.threadId } };
      if (request.method === 'mcpServerStatus/list') result = { data: [{ name: 'sitecad', tools: Object.fromEntries(mcpTools.map(tool => [tool.name, {}])) }] };
      if (request.method === 'turn/start') result = { turn: { id: 'turn' } };
      if (request.method === 'turn/steer') result = { turnId: request.params.expectedTurnId };
      send({ id: request.id, result });
      if (request.method === 'turn/start') {
        for (const event of events) send({ method: event.method, params: { threadId: request.params.threadId, ...event.params } });
        if (!holdTurn) send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: '완료' }] } } });
      }
    }); } });
  return { runtime, calls, emitted, codexHome: join(directory, 'codex'), cleanup: async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); } };
}
const modelInput = { message: '모델 검증', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] };
test('Codex receives native localImage paths and document text without serializing image data into RPC', async () => {
  const f = await modelRuntime();
  try {
    await f.runtime.chat(modelInput, { attachmentInputs: [{ name: '화면.png', kind: 'image', imagePath: '/private/sitecad/source.png', imageData: 'aW1hZ2U=' }, { name: '표.csv', kind: 'text', text: '철근,12' }] });
    const turn = f.calls.find(call => call.method === 'turn/start').params;
    assert.deepEqual(turn.input[1], { type: 'localImage', path: '/private/sitecad/source.png' });
    assert.match(turn.input[0].text, /철근,12/); assert.match(turn.input[0].text, /untrusted file contents/);
    assert.equal(JSON.stringify(turn).includes('aW1hZ2U='), false);
  } finally { await f.cleanup(); }
});
test('compound natural workflows reach Codex as real bounded native skill inputs', async () => {
  const f = await modelRuntime();
  try {
    const skills = ['quantity-review', 'design-review', 'progress-markup', 'skill-creator', 'skill-finder', 'skill-installer'].map(name => ({ name, path: join(f.codexHome, 'skills', name, 'SKILL.md') }));
    const result = await f.runtime.chat(modelInput, { skills });
    const turn = f.calls.find(call => call.method === 'turn/start').params;
    assert.deepEqual(turn.input.filter(item => item.type === 'skill'), skills.map(item => ({ type: 'skill', ...item })));
    assert.deepEqual(result.selectedSkills, skills.map(item => item.name));
    for (const { name } of skills) assert.ok(turn.input[0].text.includes(`$${name}`));
    const policy = f.calls.find(call => call.method === 'thread/start').params.baseInstructions;
    assert.match(policy, /After reporting quantity-review, design-review or progress-markup results.*end with one concise Korean question/);
    assert.match(policy, /satisfaction response.*no skill write/);
    assert.match(policy, /update.*existing editable custom skill.*new named skill/);
    await assert.rejects(f.runtime.chat(modelInput, { skills: [{ name: 'quantity-review', path: '/outside/SKILL.md' }] }), /스킬/);
    await assert.rejects(f.runtime.chat(modelInput, { skills: [skills[0], skills[0]] }), /스킬/);
  } finally { await f.cleanup(); }
});
test('steering targets the existing native turn without starting another or changing its guards', async () => {
  const fixture = await modelRuntime({ holdTurn: true });
  try {
    await assert.rejects(fixture.runtime.steer('높이는 3m로 바꿔줘'), /진행/);
    const turn = fixture.runtime.chat(modelInput);
    const cancelled = assert.rejects(turn, /중지|취소/);
    while (!fixture.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await fixture.runtime.steer('높이는 3m로 바꿔줘');
    const call = fixture.calls.find(call => call.method === 'turn/steer');
    assert.equal(call.params.threadId, 'probe');
    assert.equal(call.params.expectedTurnId, 'turn');
    assert.match(call.params.input[0].text, /높이는 3m로 바꿔줘/);
    assert.deepEqual(Object.keys(call.params).sort(), ['expectedTurnId', 'input', 'threadId']);
    assert.equal(fixture.calls.filter(call => call.method === 'turn/start').length, 1);
    for (const message of ['', 'x'.repeat(2001), 'secret\0', '/mcp add private', null]) await assert.rejects(fixture.runtime.steer(message));
    await fixture.runtime.cancel(); await cancelled;
    await assert.rejects(fixture.runtime.steer('계속해줘'), /진행/);
  } finally { await fixture.cleanup(); }
});

test('a delayed start response from a completed turn cannot retarget steering of the next turn', async () => {
  const starts = [];
  const fixture = await modelRuntime({ intercept: (request, send) => {
    if (request.method !== 'turn/start') return false;
    starts.push({ request, send }); return true;
  } });
  let nextDone;
  try {
    const first = fixture.runtime.chat(modelInput);
    while (starts.length < 1) await new Promise(resolve => setImmediate(resolve));
    const previous = starts[0];
    previous.send({ method: 'turn/completed', params: { threadId: previous.request.params.threadId,
      turn: { id: 'previous-turn', status: 'completed', items: [{ type: 'agentMessage', text: '완료' }] } } });
    await first;
    const next = fixture.runtime.chat(modelInput);
    nextDone = assert.rejects(next, /중지|취소/);
    while (starts.length < 2) await new Promise(resolve => setImmediate(resolve));
    const current = starts[1];
    current.send({ id: current.request.id, result: { turn: { id: 'current-turn' } } });
    previous.send({ id: previous.request.id, result: { turn: { id: 'previous-turn' } } });
    await new Promise(resolve => setImmediate(resolve));
    await fixture.runtime.steer('현재 작업에 추가 지시');
    assert.equal(fixture.calls.find(call => call.method === 'turn/steer').params.expectedTurnId, 'current-turn');
    await fixture.runtime.cancel(); await nextDone;
  } finally { await fixture.cleanup(); await nextDone; }
});
test('model catalog paginates, hides unavailable entries, sanitizes fields and caches copies', async () => {
  const fixture = await modelRuntime({ list: params => params.cursor ? { data: [{ id: 'alias', model: 'other', displayName: 'Other', description: 'Second', isDefault: false, private: 'secret' }] } : { data: [...Array.from({ length: 99 }, (_, index) => ({ id: `hidden-${index}`, hidden: true })), { id: 'default', displayName: 'Default', description: 'First', isDefault: true }], nextCursor: 'page2' } });
  try {
    assert.deepEqual(await fixture.runtime.listModels(), [{ id: 'default', displayName: 'Default', description: 'First', isDefault: true }, { id: 'other', displayName: 'Other', description: 'Second', isDefault: false }]);
    assert.equal(fixture.calls.some(call => call.method === 'mcpServer/tool/call'), false);
    assert.equal(fixture.runtime.status().mcp.contextVerified, false);
    const changed = await fixture.runtime.listModels(); changed[0].id = 'forged'; changed.push({ id: 'extra' });
    assert.equal((await fixture.runtime.listModels())[0].id, 'default');
    assert.deepEqual(fixture.calls.filter(call => call.method === 'model/list').map(call => call.params), [{ limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'page2' }]);
    await fixture.runtime.chat(modelInput);
    assert.equal(fixture.calls.filter(call => call.method === 'mcpServer/tool/call').length, 1);
    assert.equal(fixture.runtime.status().mcp.contextVerified, true);
  } finally { await fixture.cleanup(); }
});
test('chat model overrides reach new, resumed and already loaded threads without fallback', async () => {
  const fixture = await modelRuntime(); const sessionId = randomUUID();
  try {
    await fixture.runtime.chat(modelInput, { model: 'other', sessionId });
    await fixture.runtime.chat(modelInput, { model: 'default', sessionId, nativeThreadId: 'persistent' });
    await fixture.runtime.chat(modelInput, { model: 'other', sessionId, nativeThreadId: 'old-thread' });
    await fixture.runtime.chat(modelInput);
    assert.deepEqual(fixture.calls.filter(call => call.method === 'turn/start').map(call => call.params.model), ['other', 'default', 'other', 'default']);
    assert.equal(fixture.calls.find(call => call.method === 'thread/start' && !call.params.ephemeral).params.model, 'other');
    assert.equal(fixture.calls.find(call => call.method === 'thread/resume').params.model, 'other');
    const turns = fixture.calls.filter(call => call.method === 'turn/start').length;
    for (const model of ['missing', '', null, {}, ' default']) await assert.rejects(fixture.runtime.chat(modelInput, { model }), /모델/);
    assert.equal(fixture.calls.filter(call => call.method === 'turn/start').length, turns);
  } finally { await fixture.cleanup(); }
});
test('visible model lists beyond 100 entries continue through the returned cursor', async () => {
  const fixture = await modelRuntime({ list: params => params.cursor ? { data: [{ id: 'model-100' }] } : { data: Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}`, isDefault: index === 0 })), nextCursor: 'remaining' } });
  try {
    assert.equal((await fixture.runtime.listModels()).length, 101);
    await fixture.runtime.chat(modelInput, { model: 'model-100' });
    assert.equal(fixture.calls.find(call => call.method === 'turn/start').params.model, 'model-100');
  } finally { await fixture.cleanup(); }
});
test('model catalogs reset after restart and reject malformed or unbounded server catalogs', async t => {
  const fixture = await modelRuntime({ list: (params, starts) => ({ data: [{ id: starts === 1 ? 'old' : 'new', isDefault: true }] }) });
  try {
    assert.equal((await fixture.runtime.listModels())[0].id, 'old'); await fixture.runtime.stop();
    assert.equal(fixture.runtime.status().model, null);
    assert.equal((await fixture.runtime.listModels())[0].id, 'new');
    await assert.rejects(fixture.runtime.chat(modelInput, { model: 'old' }), /모델/);
  } finally { await fixture.cleanup(); }
  for (const [name, list] of Object.entries({ missing: () => ({}), invalid: () => ({ data: [{ id: 'bad\nmodel' }] }), duplicate: () => ({ data: [{ id: 'same' }, { model: 'same' }] }), hidden: () => ({ data: [{ id: 'hidden', hidden: true }] }), endless: params => ({ data: [{ id: `page-${params.cursor ?? 'start'}` }], nextCursor: `${params.cursor ?? ''}next` }), repeated: () => ({ data: [{ id: randomUUID() }], nextCursor: 'same' }) })) {
    await t.test(name, async () => { const invalid = await modelRuntime({ list }); try { await assert.rejects(invalid.runtime.listModels(), /모델/); assert.ok(invalid.calls.filter(call => call.method === 'model/list').length <= 5); } finally { await invalid.cleanup(); } });
  }
});
test('tool streaming preserves identity, reports logical errors and excludes reasoning deltas', async () => {
  const item = { id: 'cad-call', type: 'mcpToolCall', server: 'sitecad', tool: 'cad_context', arguments: { secret: 'private' } };
  const fixture = await modelRuntime({ events: [
    { method: 'item/started', params: { item } },
    { method: 'item/completed', params: { item: { ...item, status: 'completed', result: { isError: true } } } },
    { method: 'item/completed', params: { item: { ...item, id: 'cad-error', status: 'completed', error: {} } } },
    { method: 'item/started', params: { item: { id: 'web-call', type: 'webSearch' } } },
    { method: 'item/completed', params: { item: { id: 'web-call', type: 'webSearch' } } },
    { method: 'item/reasoning/textDelta', params: { delta: 'internal reasoning' } },
    { method: 'item/agentMessage/delta', params: { delta: '사용자 답변' } },
  ] });
  try {
    const result = await fixture.runtime.chat(modelInput);
    assert.equal(result.reply, '완료'); assert.equal(result.toolFailed, true);
    assert.deepEqual(fixture.emitted.filter(event => event.type === 'tool'), [
      { type: 'tool', id: 'cad-call', server: 'sitecad', name: 'cad_context', status: 'running' },
      { type: 'tool', id: 'cad-call', server: 'sitecad', name: 'cad_context', status: 'failed' },
      { type: 'tool', id: 'cad-error', server: 'sitecad', name: 'cad_context', status: 'failed' },
      { type: 'tool', id: 'web-call', server: 'codex', name: 'web_search', status: 'running' },
      { type: 'tool', id: 'web-call', server: 'codex', name: 'web_search', status: 'completed' },
    ]);
    assert.deepEqual(fixture.emitted.filter(event => event.type === 'delta'), [{ type: 'delta', text: '사용자 답변' }]);
    assert.doesNotMatch(JSON.stringify(fixture.emitted), /private|internal reasoning/);
    assert.deepEqual(result.details.slice(0, 2).map(detail => detail.status), ['failed', 'failed']);
  } finally { await fixture.cleanup(); }
});
test('RPC correlates responses, rejects unexpected server requests and bounds malformed output', async () => {
  const writes = [];
  const child = fakeChild((request, send) => { writes.push(request); if (request.method === 'ping') send({ id: request.id, result: { ok: true } }); });
  const rpc = new JsonRpcProcess(child, { timeoutMs: 50 });
  assert.deepEqual(await rpc.request('ping', {}), { ok: true });
  child.stdout.write(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.at(-1).error.code, -32601);
  const waiting = rpc.request('waiting', {});
  child.stdout.write('not-json\n');
  await assert.rejects(waiting, /protocol/);
  assert.equal(child.killed, true);
});
test('isolated runtime verifies MCP invocation, completes real event flow and keeps secrets out of configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-runtime-test-'));
  const calls = []; let spawned; let child;
  const spawnImpl = (binary, args, options) => {
    spawned = { binary, args, options };
    child = fakeChild((request, send) => {
      calls.push(request);
      if (!request.method || !Object.hasOwn(request, 'id')) return;
      const replies = {
        initialize: {}, 'model/list': { data: [{ id: 'test-model', model: 'test-model', isDefault: true }] },
        'thread/start': { thread: { id: 'thread-1' } },
        'mcpServerStatus/list': { data: [{ name: 'sitecad', tools: Object.fromEntries(mcpTools.map(tool=>[tool.name,{}])) }] },
        'mcpServer/tool/call': { content: [{ type: 'text', text: '{"documentId":1}' }] },
        'turn/start': { turn: { id: 'turn-1' } }, 'turn/interrupt': {},
      };
      send({ id: request.id, result: replies[request.method] ?? {} });
      if (request.method === 'turn/start') {
        send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
        send({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'mcpToolCall', server: 'sitecad', tool: 'cad_execute' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'mcpToolCall', server: 'sitecad', tool: 'cad_execute', status: 'completed', result: { structuredContent: { created: 1 } } } } });
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '작성했습니다.' } });
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
      }
    }); return child;
  };
  const options = { codexPath: '/app/codex', nodePath: '/app/electron', nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, mcpPath: '/app/sitecad-mcp.mjs', codexHome: join(directory, 'codex'), workspace: join(directory, 'workspace'), bridgeUrl: 'http://127.0.0.1:1234', bridgeToken: 'bridge-private'.repeat(4), getAccessToken: async () => 'oauth-private', spawnImpl };
  const runtime = createCodexRuntime(options);
  try {
    await runtime.start();
    assert.equal(runtime.status().connected, true);
    assert.ok(calls.some(call => call.method === 'mcpServer/tool/call' && call.params.tool === 'cad_context'));
    assert.equal(spawned.options.env.ACCESS_TOKEN, 'oauth-private');
    assert.equal(spawned.options.env.CODEX_HOME, options.codexHome);
    assert.equal(spawned.options.env.OPENAI_API_KEY, undefined);
    const config = await readFile(join(options.codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /oauth-private|bridge-private/);
    assert.match(config, /env_vars/);
    const result = await runtime.chat({ message: '도면 생성', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] }, {skill:{name:'example',path:join(options.codexHome,'skills/example/SKILL.md')}});
    assert.equal(result.reply, '작성했습니다.');
    assert.deepEqual(result.reports, [{ created: 1 }]);
    assert.deepEqual(result.details, [{ tool: 'cad_execute', status: 'completed' }]);
    assert.equal(runtime.status().inferenceVerified, true);
    const turnInput = calls.find(call=>call.method==='turn/start').params.input;
    assert.equal(turnInput[1].type,'skill');
    assert.equal(turnInput[1].name,'example');
    assert.equal(turnInput[1].path,join(options.codexHome,'skills/example/SKILL.md'));
    assert.match(turnInput[0].text,/\$example/);
    const threadParams=calls.find(call => call.method === 'thread/start').params;
    assert.equal(threadParams.sandbox, 'read-only');
    assert.match(threadParams.baseInstructions,/set_properties/);
    assert.match(threadParams.baseInstructions,/block_define/);
    assert.match(threadParams.baseInstructions,/page_setup_set/);
    assert.match(threadParams.baseInstructions,/STYLE and DIMSTYLE.*LIST.*NEW/);
    assert.match(threadParams.baseInstructions,/plot and wblock.*native-only/i);
    assert.match(threadParams.baseInstructions,/2D.*3D/);
    assert.match(threadParams.baseInstructions,/Solid3D/);
    assert.match(threadParams.baseInstructions,/3DPOLY/);
    assert.match(threadParams.baseInstructions,/volume/);
    assert.match(threadParams.baseInstructions,/tessellat.*approximat|approximat.*tessellat/i);
    assert.match(threadParams.baseInstructions,/reopen.*(?:change|differ)|(?:change|differ).*reopen/i);
    assert.match(threadParams.baseInstructions,/zero.*bounds.*(?:unknown|unsupported|unavailable).*not.*point/i);
    assert.match(threadParams.baseInstructions,/quantity-review/);
    assert.match(threadParams.baseInstructions,/mmPerDrawingUnit.*null/);
    assert.match(threadParams.baseInstructions,/tag.*diameter.*length.*count.*schedule/i);
    assert.match(threadParams.baseInstructions,/review results.*GFM table.*not.*code fence/i);
    assert.match(threadParams.baseInstructions,/cannot produce.*ask.*wanted.*handling rules/i);
    assert.match(threadParams.baseInstructions,/failed request.*never.*permission.*save/i);
    assert.match(threadParams.baseInstructions,/accepted procedure.*skill-creator.*registration/i);
    assert.match(threadParams.baseInstructions,/quantity_review.*not.*rebar/i);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(child.killed, true);
});
test('configuration isolates trusted workspace, disables shell and does not merge user MCP settings', () => {
  const config = runtimeConfig({ workspace: '/private/app/workspace', nodePath: '/app/node', mcpPath: '/app/mcp.mjs' });
  assert.match(config, /shell_tool = false/);
  assert.match(config, /unified_exec = false/);
  assert.match(config, /multi_agent_v2 = false/);
  assert.match(config, /\[features.code_mode_host\]\nenabled = false\ndisable_in_process_fallback = true/);
  assert.match(config, /trust_level = "trusted"/);
  assert.match(config, /omit_tools_from = \["deferred", "code_mode"\]/);
  for (const name of ['cad_context', 'cad_execute', 'cad_save']) assert.ok(config.includes(`[mcp_servers.sitecad.tools.${name}]\napproval_mode = "approve"`));
  assert.deepEqual(config.match(/^\[mcp_servers\.[^.\]]+\]$/gm), ['[mcp_servers.sitecad]']);
});
test('persistent chat sessions use separate native threads, resume across restarts, and wait for optional MCP startup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sitecad-sessions-runtime-'));
  const calls=[];let serial=0,inventoryReads=0;
  const runtime=createCodexRuntime({codexPath:'/app/codex',nodePath:process.execPath,mcpPath:'/app/mcp.mjs',codexHome:join(directory,'codex'),workspace:join(directory,'workspace'),bridgeUrl:'http://127.0.0.1:1234',bridgeToken:'x'.repeat(32),getAccessToken:async()=> 'token',externalServers:[{name:'slow',transport:'http',url:'https://example.org/mcp'}],
    spawnImpl:()=>fakeChild((request,send)=>{
      if(!request.method||!Object.hasOwn(request,'id'))return;
      calls.push(request);let result={};
      if(request.method==='model/list')result={data:[{id:'model'}]};
      if(request.method==='thread/start')result={thread:{id:request.params.ephemeral?'probe':`persist-${++serial}`}};
      if(request.method==='thread/resume')result={thread:{id:request.params.threadId}};
      if(request.method==='mcpServerStatus/list')result={data:[{name:'sitecad',tools:Object.fromEntries(mcpTools.map(tool=>[tool.name,{}]))},{name:'slow',runtimeStatus:++inventoryReads>=3?'connected':'starting',tools:inventoryReads>=3?{ping:{}}:{}}]};
      if(request.method==='turn/start')result={turn:{id:'turn'}};
      send({id:request.id,result});
      if(request.method==='turn/start')send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'완료'}]}}});
    })});
  const input={message:'첫 대화',context:{documentId:1,revision:0,units:4,selection:[],entities:[]},history:[]};
  const first=randomUUID(),second=randomUUID();let firstThread,secondThread;
  try{
    await runtime.start();
    assert.equal((await runtime.testExternal('slow',{waitMs:1000})).tested,true);
    assert.ok(inventoryReads>=3);
    await runtime.chat(input,{sessionId:first,onThread:id=>{firstThread=id;}});
    await runtime.chat({...input,message:'다른 대화'},{sessionId:second,onThread:id=>{secondThread=id;}});
    await runtime.chat({...input,message:'첫 대화 재개'},{sessionId:first,nativeThreadId:firstThread});
    assert.notEqual(firstThread,secondThread);
    assert.deepEqual(calls.filter(item=>item.method==='turn/start').map(item=>item.params.threadId),[firstThread,secondThread,firstThread]);
    await runtime.stop();
    await runtime.chat(input,{sessionId:first,nativeThreadId:firstThread});
    assert.equal(calls.filter(item=>item.method==='thread/resume').at(-1).params.threadId,firstThread);
    assert.equal(calls.filter(item=>item.method==='thread/resume').at(-1).params.excludeTurns,true);
    await assert.rejects(runtime.chat(input,{skill:{name:'bad',path:'/outside/SKILL.md'}}),/스킬/);
  }finally{await runtime.stop();await rm(directory,{recursive:true,force:true});}
});
test('external MCP config contains no credentials and research tools use a narrow internal approval list', () => {
  const apiKey = randomUUID(); const bearerToken = randomUUID();
  const config = runtimeConfig({ workspace: '/private/workspace', nodePath: '/app/node', mcpPath: '/app/sitecad-mcp.mjs', researchTools: [{ name: 'cad_fetch' }, { name: 'cad_design_note' }, { name: 'cad_vworld_geocode' }, { name: 'cad_vworld_parcels' }], externalServers: [
    { name: 'local_ref', transport: 'stdio', command: '/app/python', args: ['server.py'], env: { API_KEY: apiKey }, enabledTools: [] },
    { name: 'remote_ref', transport: 'http', url: 'https://example.com/mcp', bearerToken, enabledTools: ['lookup'] },
  ] });
  assert.match(config, /web_search = "live"/);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /mcp-launcher\.mjs/);
  assert.match(config, /SITECAD_MCP_LAUNCH_LOCAL_REF/);
  assert.match(config, /SITECAD_MCP_TOKEN_REMOTE_REF/);
  assert.match(config, /default_tools_approval_mode = "prompt"/);
  assert.match(config, /cad_design_note/);
  assert.match(config, /cad_vworld_geocode/);
  assert.match(config, /cad_vworld_parcels/);
  assert.match(config, /cad_terrain_register/);
  assert.doesNotMatch(config, /enabled_tools = \[\]/);
  assert.equal(config.includes(apiKey) || config.includes(bearerToken), false);
});
test('standard Responses search probe accepts only an explicit absolute local catalog', () => {
  const config = runtimeConfig({ workspace: '/private/workspace', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', modelCatalogPath: '/private/app/sitecad-models.json' });
  assert.match(config, /model_catalog_json = "\/private\/app\/sitecad-models.json"/);
  assert.match(config, /shell_tool = false/);
  assert.match(config, /\[features.code_mode_host\]\nenabled = false/);
  assert.throws(() => runtimeConfig({ workspace: '/private/workspace', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', modelCatalogPath: 'relative.json' }), /카탈로그/);
});
test('the packaged model catalog preserves standard Responses support for verified hosted search', async () => {
  const catalog = JSON.parse(await readFile(new URL('../codex-models.json', import.meta.url), 'utf8'));
  assert.equal(catalog.models.length, 11);
  assert.equal(catalog.models.filter(item => item.visibility === 'list').length, 8);
  assert.ok(catalog.models.every(item => item.use_responses_lite === false));
  const model = catalog.models.find(item => item.slug === 'gpt-6.1-sol');
  assert.equal(model?.use_responses_lite, false, 'Responses Lite omits hosted web search in Codex 0.163');
  assert.ok(['text', 'text_and_image'].includes(model.web_search_tool_type));
  assert.ok(model.supported_reasoning_levels.length > 0);
});
test('RPC handles bounded asynchronous approval responses without permitting generic execution', async () => {
  const writes = [];
  const child = fakeChild(request => writes.push(request));
  const rpc = new JsonRpcProcess(child, { onRequest: async method => method === 'mcpServer/elicitation/request' ? { action: 'decline', content: null } : undefined });
  child.stdout.write(JSON.stringify({ id: 5, method: 'mcpServer/elicitation/request', params: {} }) + '\n');
  child.stdout.write(JSON.stringify({ id: 6, method: 'item/fileChange/requestApproval', params: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.find(value => value.id === 5).result.action, 'decline');
  assert.equal(writes.find(value => value.id === 6).error.code, -32601);
  await rpc.stop();
});
test('RPC accepts the measured REA inventory size while retaining a bounded input limit', async () => {
  const payload = 'x'.repeat(3_200_000);
  const child = fakeChild((request, send) => send({ id: request.id, result: { inventory: payload } }));
  const rpc = new JsonRpcProcess(child);
  try {
    assert.equal((await rpc.request('mcpServerStatus/list', {})).inventory.length, payload.length);
    await assert.rejects(rpc.request('oversized-input', { data: 'x'.repeat(1024 * 1024) }), /크기/);
  } finally { await rpc.stop(); }
});
test('external MCP approval binds exact active tool arguments and web research preserves safe sources', async t => {
  for (const mode of ['approve', 'deny', 'wrongArguments', 'wrongThread', 'wrongKind', 'genericForm', 'cancelled']) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sitecad-external-test-'));
    let captured; let approveCount = 0; let resolveApproval; let notifyApproval;
    const approvalAsked = new Promise(resolve => { notifyApproval = resolve; });
    const input = { message: '기준 검색', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] };
    const options = { codexPath: '/app/codex', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', codexHome: join(directory, 'codex'), workspace: join(directory, 'workspace'), bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), getAccessToken: async () => 'private-oauth', externalServers: [{ name: 'reference', transport: 'stdio', command: '/app/python', args: ['ref.py'], env: { REF_KEY: 'private-ref-key' }, enabledTools: [] }, { name: 'optional', transport: 'http', url: 'https://example.com/mcp', bearerToken: 'private-bearer' }],
      onApproval: async request => { approveCount++; assert.deepEqual(request, { server: 'reference', tool: 'lookup', arguments: { query: 'road' } }); notifyApproval(); return mode === 'cancelled' ? new Promise(resolve => { resolveApproval = resolve; }) : mode === 'deny' ? 'deny' : 'approve'; },
      spawnImpl: (binary, args, settings) => { captured = settings; return fakeChild((request, send) => {
        if (!request.method) {
          if (request.id === 900) { assert.equal(request.result.action, mode === 'approve' ? 'accept' : 'decline'); send({ method: 'item/completed', params: { threadId: 't', item: { id: 'call1', type: 'mcpToolCall', server: 'reference', tool: 'lookup', status: 'completed', result: { structuredContent: { browserTargets: [{ url: 'http://127.0.0.1:4317', title: 'SiteCAD local editor' }] } } } } }); send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } }); }
          return;
        }
        if (!Object.hasOwn(request, 'id')) return;
        const replies = { initialize: {}, 'model/list': { data: [{ id: 'model' }] }, 'thread/start': { thread: { id: 't' } }, 'mcpServerStatus/list': { data: [{ name: 'sitecad', tools: Object.fromEntries(mcpTools.map(tool=>[tool.name,{}])) }, { name: 'reference', tools: { lookup: {} }, runtimeStatus: 'connected' }] }, 'mcpServer/tool/call': {}, 'turn/start': { turn: { id: 'turn' } }, 'turn/interrupt': {} };
        send({ id: request.id, result: replies[request.method] });
        if (request.method === 'turn/start') {
          send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn' } } });
          send({ method: 'item/started', params: { threadId: 't', item: { id: 'web', type: 'webSearch', query: 'road' } } });
          send({ method: 'item/completed', params: { threadId: 't', item: { id: 'web', type: 'webSearch', results: [{ url: 'https://standards.example/road', title: 'Road standard' }, { url: 'javascript:alert(1)' }, { url: 'https://u:p@example.com/private' }, { url: 'https://standards.example/road' }] } } });
          send({ method: 'item/started', params: { threadId: 't', item: { id: 'call1', type: 'mcpToolCall', server: 'reference', tool: 'lookup', arguments: { query: 'road' } } } });
          send({ id: 900, method: 'mcpServer/elicitation/request', params: { serverName: 'reference', threadId: mode === 'wrongThread' ? 'other' : 't', turnId: 'turn', mode: 'form', requestedSchema: { type: 'object', properties: mode === 'genericForm' ? { password: { type: 'string' } } : {} }, _meta: { codex_approval_kind: mode === 'wrongKind' ? 'other' : 'mcp_tool_call', tool_params: { query: mode === 'wrongArguments' ? 'stolen' : 'road' } } } });
        }
      }); },
    };
    const runtime = createCodexRuntime(options);
    try {
      await runtime.start();
      assert.equal((await runtime.testExternal('reference')).tested, true);
      assert.equal((await runtime.testExternal('optional')).tested, false);
      await assert.rejects(runtime.testExternal('unknown'), /등록/);
      assert.equal(JSON.parse(captured.env.SITECAD_MCP_LAUNCH_REFERENCE).env.REF_KEY, 'private-ref-key');
      assert.equal(captured.env.SITECAD_MCP_TOKEN_OPTIONAL, 'private-bearer');
      const config = await readFile(join(options.codexHome, 'config.toml'), 'utf8');
      assert.doesNotMatch(config, /private-ref-key|private-bearer|private-oauth/);
      const pending = runtime.chat(input);
      if (mode === 'cancelled') { const rejected = assert.rejects(pending, /중지/); await approvalAsked; await runtime.stop(); resolveApproval('approve'); await rejected; }
      else { const result = await pending; assert.deepEqual(result.sources, [{ url: 'https://standards.example/road', title: 'Road standard' }]); assert.equal(approveCount, ['approve', 'deny'].includes(mode) ? 1 : 0); }
    } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});
test('cancel during delayed token retrieval never starts a process or a model turn', async () => {
  let release;
  const pendingToken = new Promise(resolve => { release = resolve; });
  let starts = 0;
  const runtime = createCodexRuntime({ codexPath: '/app/codex', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', codexHome: '/private/tmp/sitecad-unused-codex', workspace: '/private/tmp/sitecad-unused-workspace', bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), getAccessToken: () => pendingToken, spawnImpl: () => { starts++; throw Error('must not start'); } });
  const starting = runtime.start();
  const rejected = assert.rejects(starting, /취소/);
  await runtime.cancel(); release('late-private-token');
  await rejected;
  assert.equal(starts, 0);
  assert.equal(runtime.status().running, false);
  let releaseChat;
  const chatToken = new Promise(resolve => { releaseChat = resolve; });
  const chatRuntime = createCodexRuntime({ codexPath: '/app/codex', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', codexHome: '/private/tmp/sitecad-unused-codex', workspace: '/private/tmp/sitecad-unused-workspace', bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), getAccessToken: () => chatToken, spawnImpl: () => { starts++; throw Error('must not start'); } });
  const chat = chatRuntime.chat({ message: '생성', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] });
  const chatRejected = assert.rejects(chat, /취소/);
  await chatRuntime.cancel(); releaseChat('late-chat-token');
  await chatRejected; assert.equal(starts, 0);
});
test('stop during initialization rejects startup and kills the process before any later requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-cancel-test-'));
  const calls = []; let spawned; let initialized;
  const didInitialize = new Promise(resolve => { initialized = resolve; });
  const runtime = createCodexRuntime({ codexPath: '/app/codex', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', codexHome: join(directory, 'codex'), workspace: join(directory, 'workspace'), bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), getAccessToken: async () => 'token', spawnImpl: () => {
    spawned = fakeChild(request => { calls.push(request); if (request.method === 'initialize') initialized(); }); return spawned;
  } });
  try {
    const starting = runtime.start(); const rejected = assert.rejects(starting, /종료/);
    await didInitialize; await runtime.stop(); await rejected;
    assert.equal(spawned.killed, true);
    assert.deepEqual(calls.map(request => request.method), ['initialize']);
    assert.equal(runtime.status().connected, false);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});
test('RPC timeout and excessive output terminate the process and reject pending work', async () => {
  for (const oversized of [false, true]) {
    const child = fakeChild(() => {});
    const rpc = new JsonRpcProcess(child, { timeoutMs: 5 });
    const waiting = rpc.request('work', {});
    const rejected = assert.rejects(waiting, oversized ? /limit/ : /초과/);
    if (oversized) child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    await rejected; assert.equal(child.killed, true); await rpc.stop();
    await assert.rejects(rpc.request('late', {}), /종료/);
  }
});
test('runtime fails closed for startup inventory errors and forbidden or failed model actions', async t => {
  for (const mode of ['noauth', 'emptyModels', 'foreignMcp', 'missingTool', 'probeError', 'failedTurn', 'interruptedTurn', 'wrongTool', 'shellTool', 'tooManyTools', 'interactiveBudget', 'timeLimit', 'oversizedTrace', 'errorEvent', 'toolError', 'fallbackReply']) {
    await t.test(mode, async subtest => {
      if (mode === 'timeLimit') subtest.mock.timers.enable({ apis: ['setTimeout'] });
      const directory = await mkdtemp(join(tmpdir(), 'sitecad-runtime-gate-'));
      let child;
      const runtime = createCodexRuntime({ codexPath: '/app/codex', nodePath: '/app/node', mcpPath: '/app/mcp.mjs', codexHome: join(directory, 'codex'), workspace: join(directory, 'workspace'), bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), getAccessToken: async () => mode === 'noauth' ? '' : 'test-token', onEvent: () => { throw Error('UI listener failure must not break runtime'); }, spawnImpl: () => {
        child = fakeChild((request, send) => {
          if (!Object.hasOwn(request, 'id') || !request.method) return;
          const tools = Object.fromEntries(mcpTools.map(tool=>[tool.name,{}]));
          if (mode === 'missingTool') delete tools.cad_save;
          const replies = {
            initialize: {}, 'model/list': { data: mode === 'emptyModels' ? [] : [{ id: 'test-model', isDefault: false }] },
            'thread/start': { thread: { id: 't' } },
            'mcpServerStatus/list': { data: [{ name: mode === 'foreignMcp' ? 'other' : 'sitecad', tools }] },
            'mcpServer/tool/call': { content: [], isError: mode === 'probeError' },
            'turn/start': { turn: { id: 'turn' } },
          };
          send({ id: request.id, result: replies[request.method] ?? {} });
          if (request.method !== 'turn/start') return;
          send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', delta: 'ignore' } });
          const event = (method, params) => send({ method, params: { threadId: 't', ...params } });
          if (mode === 'wrongTool') event('item/started', { item: { type: 'mcpToolCall', server: 'other', tool: 'shell' } });
          else if (mode === 'shellTool') event('item/started', { item: { type: 'commandExecution' } });
          else if (mode === 'timeLimit') {
            subtest.mock.timers.tick(300001);
            assert.equal(runtime.status().busy, true);
            subtest.mock.timers.tick(300000);
          }
          else if (mode === 'tooManyTools' || mode === 'interactiveBudget') {
            for (let i = 0; i < (mode === 'tooManyTools' ? 65 : 40); i++) {
              const item = { id: `cad-${i}`, type: 'mcpToolCall', server: 'sitecad', tool: i % 2 ? 'cad_context' : 'cad_control', arguments: i % 2 ? {} : { request: { op: 'input', kind: 'point', point: [i, 0, 0] } } };
              event('item/started', { item });
              event('item/completed', { item: { ...item, status: 'completed', result: { structuredContent: { status: i === 39 ? 'completed' : 'waiting_input' } } } });
            }
            event('turn/completed', { turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: '확인했습니다.' }] } });
          }
          else if (mode === 'errorEvent') event('error', { willRetry: false, message: 'private-upstream-error' });
          else {
            if (mode === 'oversizedTrace') event('item/completed', { item: { type: 'mcpToolCall', server: 'sitecad', tool: 'cad_query', status: 'completed', result: { structuredContent: { text: 'x'.repeat(33000) } } } });
            if (mode === 'toolError') event('item/completed', { item: { type: 'mcpToolCall', server: 'sitecad', tool: 'cad_execute', status: 'failed', error: {} } });
            event('turn/completed', { turn: { id: 'turn', status: mode === 'failedTurn' ? 'failed' : mode === 'interruptedTurn' ? 'interrupted' : 'completed', items: [{ type: 'agentMessage', text: '확인했습니다.' }] } });
          }
        }); return child;
      } });
      try {
        const action = runtime.chat({ message: '테스트', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] });
        if (['toolError', 'fallbackReply', 'interactiveBudget', 'oversizedTrace'].includes(mode)) {
          const result = await action; assert.equal(result.reply, '확인했습니다.'); assert.equal(result.toolFailed, mode === 'toolError');
          if (mode === 'interactiveBudget') {
            assert.equal(result.execution.toolCalls, 40);
            assert.equal(result.execution.limit, 64);
            assert.equal(result.execution.timeoutMs, 600000);
            assert.equal(result.cadTrace.length, 40);
            assert.equal(result.cadTrace[0].result.structuredContent.status, 'waiting_input');
          }
          if (mode === 'oversizedTrace') assert.equal(result.cadTrace[0].result.truncated, true);
        } else if (['tooManyTools', 'timeLimit'].includes(mode)) await assert.rejects(action, /부분 변경.*미저장/);
        else await assert.rejects(action);
      } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
      assert.equal(runtime.status().connected, false);
      if (child) assert.equal(child.killed, true);
    });
  }
});


test('completed final messages replace commentary and abandoned draft deltas', async () => {
  const fixture = await modelRuntime({ events: [
    {method:'item/started',params:{item:{type:'agentMessage',id:'comment',phase:'commentary',text:''}}},
    {method:'item/agentMessage/delta',params:{itemId:'comment',delta:'먼저 확인하겠습니다.'}},
    {method:'item/completed',params:{item:{type:'agentMessage',id:'comment',phase:'commentary',text:'먼저 확인하겠습니다.'}}},
    {method:'item/started',params:{item:{type:'agentMessage',id:'draft',phase:'final_answer',text:''}}},
    {method:'item/agentMessage/delta',params:{itemId:'draft',delta:'日本語 | 중간 표 |'}},
    {method:'item/started',params:{item:{type:'agentMessage',id:'final',phase:'final_answer',text:''}}},
    {method:'item/agentMessage/delta',params:{itemId:'final',delta:'한국어 최종 결과'}},
    {method:'item/completed',params:{item:{type:'agentMessage',id:'final',phase:'final_answer',text:'한국어 최종 결과'}}},
  ] });
  try {
    // turn/completed snapshots are authoritative, even after completed item events.
    const result=await fixture.runtime.chat(modelInput);
    assert.equal(result.reply,'완료');
    assert.ok(fixture.emitted.some(item=>item.type==='reply_start'));
  } finally {await fixture.cleanup();}
});

test('item completed final is used when turn completion omits its items', async () => {
  const fixture=await modelRuntime({intercept(request,send){
    if(request.method!=='turn/start')return false;
    send({id:request.id,result:{turn:{id:'turn'}}});
    for(const item of [{id:'comment',phase:'commentary',text:'중간 안내'},{id:'answer',phase:'final_answer',text:'최종 표'}]){
      send({method:'item/agentMessage/delta',params:{threadId:request.params.threadId,itemId:item.id,delta:item.text}});
      send({method:'item/completed',params:{threadId:request.params.threadId,item:{type:'agentMessage',...item}}});
    }
    send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn',status:'completed',items:[]}}});
    return true;
  }});
  try{assert.equal((await fixture.runtime.chat(modelInput)).reply,'최종 표');}finally{await fixture.cleanup();}
});

test('the fixed ten minute deadline rejects incomplete text but retains execution evidence',async()=>{
  let deadline,delay,cleared;
  const fixture=await modelRuntime({holdTurn:true,events:[
    {method:'item/agentMessage/delta',params:{delta:'중간 표 | 미완료'}},
    {method:'item/completed',params:{item:{id:'saved',type:'mcpToolCall',server:'sitecad',tool:'cad_save',status:'completed',result:{structuredContent:{saved:true}}}}},
  ],runtimeOptions:{setTimeoutImpl:(callback,ms)=>{deadline=callback;delay=ms;return 'deadline';},clearTimeoutImpl:timer=>{cleared=timer;}}});
  try{
    const pending=fixture.runtime.chat(modelInput);
    const failure=assert.rejects(pending,error=>{
      assert.equal(error.code,'SITECAD_TURN_TIMEOUT');
      assert.equal(error.execution.timeoutMs,600000);
      assert.equal(error.details[0].tool,'cad_save');
      assert.equal(error.reply,undefined);
      return /10분/.test(error.message);
    });
    while(!fixture.emitted.some(item=>item.type==='tool'))await new Promise(resolve=>setImmediate(resolve));
    assert.equal(delay,600000);deadline();await failure;assert.equal(cleared,'deadline');
  }finally{await fixture.cleanup();}
});

test('a late nested turn id cannot finish the next turn on the same native thread',async()=>{
  let turns=0;
  const fixture=await modelRuntime({intercept(request,send){
    if(request.method!=='turn/start')return false;
    const id=`turn-${++turns}`;
    send({id:request.id,result:{turn:{id}}});
    send({method:'turn/started',params:{threadId:request.params.threadId,turn:{id}}});
    if(turns===2)send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'과거 답변'}]}}});
    send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id,status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:`현재 답변 ${turns}`}]}}});
    return true;
  }});
  try{
    assert.equal((await fixture.runtime.chat(modelInput)).reply,'현재 답변 1');
    assert.equal((await fixture.runtime.chat(modelInput)).reply,'현재 답변 2');
  }finally{await fixture.cleanup();}
});
test('a completed turn with commentary only never promotes it to a final result',async()=>{
  const fixture=await modelRuntime({intercept(request,send){
    if(request.method!=='turn/start')return false;
    send({id:request.id,result:{turn:{id:'turn'}}});
    send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:'확인 중'}]}}});return true;
  }});
  try{await assert.rejects(fixture.runtime.chat(modelInput),/최종 답변/);}finally{await fixture.cleanup();}
});

for (const phase of ['commentary','final_answer']) test(`unfinished ${phase} deltas never become a final answer when completion has no items`,async()=>{
  const fixture=await modelRuntime({intercept(request,send){
    if(request.method!=='turn/start')return false;
    send({id:request.id,result:{turn:{id:'turn'}}});
    const params={threadId:request.params.threadId,turnId:'turn'};
    send({method:'item/started',params:{...params,item:{type:'agentMessage',id:'unfinished',phase,text:''}}});
    send({method:'item/agentMessage/delta',params:{...params,itemId:'unfinished',delta:'미완료 중간 표'}});
    send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn',status:'completed',items:[]}}});
    return true;
  }});
  try{await assert.rejects(fixture.runtime.chat(modelInput),/최종 답변/);}finally{await fixture.cleanup();}
});

test('a stale completion immediately after the next start RPC response cannot win its microtask race',async()=>{
  let turns=0;
  const fixture=await modelRuntime({intercept(request,send){
    if(request.method!=='turn/start')return false;
    const id=`race-${++turns}`;
    send({id:request.id,result:{turn:{id}}});
    if(turns===2)send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'race-1',status:'completed',items:[{type:'agentMessage',text:'과거 답변'}]}}});
    send({method:'turn/started',params:{threadId:request.params.threadId,turn:{id}}});
    send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id,status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:`현재 답변 ${turns}`}]}}});return true;
  }});
  try{
    assert.equal((await fixture.runtime.chat(modelInput)).reply,'현재 답변 1');
    assert.equal((await fixture.runtime.chat(modelInput)).reply,'현재 답변 2');
  }finally{await fixture.cleanup();}
});
