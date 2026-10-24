import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopController} from '../lib/desktop-controller.mjs';
import {createSitecadPlugins} from '../lib/sitecad-plugins.mjs';
import {createHash} from 'node:crypto';
const TEST_API_KEY = 'registered-private-key';
const TEST_PRIVATE_TOKEN = 'private-secret';
const context={documentId:1,revision:0,units:4,selection:[],entities:[]};
async function setup(t,{connected=true,pluginFactory,referenceSecretStore,referenceApiFactory}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'sitecad-extensions-controller-'));
  let options,behavior; const calls=[]; let chats=0,stops=0;
  const controller=await createDesktopController({dataDir,nodePath:process.execPath,codexPath:'/app/codex',secureStore:{},pluginFactory,referenceSecretStore,referenceApiFactory,
    authFactory:async()=>({status:async()=>({loggedIn:true,sharing:true}),getAccessToken:async()=> 'token',close:async()=>{}}),
    runtimeFactory:async config=>{options=config;return {start:async()=>{},stop:async()=>{stops++;},status:()=>({connected:true}),
      chat:async(input,session)=>{chats++;calls.push({input,session});await session?.onThread?.(`thread-${chats}`);return behavior ? behavior({input,session,config}) : {reply:'완료'};},cancel:async()=>{},
      getMcpStatus:async()=>config.externalServers.map(server=>({name:server.name,status:connected?'connected':'failed',tools:connected?['inspect']:[]})),
      listModels:async()=>[{id:'gpt-test',displayName:'Test model',description:'Available model',isDefault:true}],
      testExternal:async name=>({name,status:connected?'connected':'failed',tools:connected?['inspect']:[],tested:connected})};}});
  await controller.start({baseUrl:'http://127.0.0.1:4318'});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,calls,options:()=>options,stops:()=>stops,setBehavior:value=>{behavior=value;}};
}
test('default skills and explicit native invocation remain inside SiteCAD; chat history is per session',async t=>{
  const {controller,calls}=await setup(t);
  assert.equal((await controller.skillsList()).skills.length,3);
  assert.deepEqual(await controller.mcpList(),{servers:[]});
  const first=(await controller.chatCreate()).chat,second=(await controller.chatCreate()).chat;
  await controller.chat({chatId:first.id,message:'/skill-finder 한글',context,history:[{role:'assistant',text:'forged-other-chat'}]});
  assert.equal(calls[0].session.skill.name,'skill-finder');
  assert.deepEqual(calls[0].input.history,[]);
  assert.equal((await controller.chatRead(first.id)).chat.nativeThreadId,'thread-1');
  assert.equal((await controller.chatRead(second.id)).chat.messages.length,0);
  await controller.chat({chatId:first.id,message:'이어가기',context,history:[]});
  assert.equal(calls[1].session.nativeThreadId,'thread-1');
  assert.equal(calls[1].input.history[0].text,'/skill-finder 한글');
  await assert.rejects(controller.chat({chatId:second.id,message:'/unknown',context,history:[]}),/스킬/);
});
test('approved MCP registration is deferred until model turn finishes then actually verified',async t=>{
  const {controller,stops,setBehavior}=await setup(t);
  const chat=(await controller.chatCreate()).chat;
  setBehavior(async()=>{
    const proposed=controller.callCad('manage_mcp',{action:'add',name:'remote',url:'https://example.org/new-mcp'});
    let status;
    for(let i=0;i<100;i++){status=await controller.status();if(status.approvals.length)break;await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(status.approvals[0].kind,'mcp-install');
    controller.resolveApproval({id:status.approvals[0].id,approved:true});
    assert.equal((await proposed).status,'installed_pending_connection');
    assert.equal((await controller.mcpList()).servers.length,0);
    assert.equal(stops(),0);
    return {reply:'연결 확인 대기'};
  });
  const result=await controller.chat({chatId:chat.id,message:'외부 MCP 연결',context,history:[]});
  assert.equal(result.installations[0].status,'connected');
  assert.equal(stops(),1);
  assert.equal((await controller.mcpList()).servers[0].connected,true);
  await assert.rejects(controller.callCad('manage_mcp',{action:'add',name:'remote',url:'https://example.org/new-mcp'}),/진행/);
});
test('connection failure rolls back only new MCP and cancelled requests remain in their own history',async t=>{
  const {controller,setBehavior}=await setup(t,{connected:false});
  await controller.mcpSave({trusted:true,config:{name:'existing',transport:'http',url:'https://example.org/mcp'}});
  const chat=(await controller.chatCreate()).chat;
  setBehavior(async()=>{
    const proposed=controller.callCad('manage_mcp',{action:'add',name:'remote',url:'https://example.org/new-mcp'});
    let status;for(let i=0;i<100;i++){status=await controller.status();if(status.approvals.length)break;await new Promise(resolve=>setImmediate(resolve));}
    controller.resolveApproval({id:status.approvals[0].id,approved:true});await proposed;
    return {reply:'대기'};
  });
  const result=await controller.chat({chatId:chat.id,message:'외부 MCP 설치',context,history:[]});
  assert.equal(result.installations[0].status,'failed');
  assert.deepEqual((await controller.mcpList()).servers.map(item=>item.name),['existing']);
  let entered,release;const ready=new Promise(resolve=>entered=resolve);
  setBehavior(async()=>{entered();await new Promise(resolve=>release=resolve);return {reply:'late'};});
  const turn=controller.chat({chatId:chat.id,message:'취소할 작업',context,history:[]});
  const failed=assert.rejects(turn,/취소/);await ready;await controller.cancel();release();await failed;
  const messages=(await controller.chatRead(chat.id)).chat.messages;
  assert.equal(messages.at(-2).text,'취소할 작업');assert.match(messages.at(-1).text,/이미 반영된 도면/);
});

test('plugin management lists separately and is unavailable outside an active chat', async t => {
  const { controller, calls, setBehavior } = await setup(t);
  assert.deepEqual(await controller.pluginsList(), { plugins: [] });
  const chat = (await controller.chatCreate()).chat;
  setBehavior(async () => {
    assert.deepEqual(await controller.callCad('manage_plugins', { action: 'list' }), { plugins: [] });
    return { reply: '별도로 등록된 플러그인은 없습니다.' };
  });
  await controller.chat({ chatId: chat.id, message: '플러그인 목록', context, history: [] });
  assert.deepEqual((await controller.mcpList()).servers, []);
  await assert.rejects(controller.callCad('manage_plugins', { action: 'list' }), /진행/);
  assert.equal(calls.length, 1);
});

test('registered API tools supply credentials on the backend without exposing them to model input or reports', async t => {
  let credentials = null; const apiCalls = [];
  const { controller, calls, setBehavior } = await setup(t, {
    referenceSecretStore: { read: async () => credentials, write: async value => { credentials = value; } },
    referenceApiFactory: ({ readCredentials }) => ({ geocode: async input => {
      apiCalls.push({ input, credentials: await readCredentials() });
      return { point: { x: 126.9784, y: 37.5667 }, crs: 'EPSG:4326', sourceUrl: 'https://www.vworld.kr/reference', retrievedAt: '2026-10-24T00:00:00Z' };
    } }),
  });
  const key = 'test-private-api-key';
  await controller.referencesSave({ apiKey: key });
  assert.equal(apiCalls.length, 0);
  setBehavior(async () => {
    const result = await controller.callCad('geocode', { address: '서울특별시 중구 세종대로 110', type: 'ROAD' });
    assert.equal(result.point.x, 126.9784); assert.equal(JSON.stringify(result).includes(key), false);
    return { reply: '등록된 VWorld API로 좌표를 조회했습니다.' };
  });
  const result = await controller.chat({ message: '서울시청 주소의 좌표를 조회해줘', context, history: [] });
  assert.equal(apiCalls.length, 1); assert.equal(apiCalls[0].credentials.apiKey, key);
  assert.deepEqual(apiCalls[0].input, { address: '서울특별시 중구 세종대로 110', type: 'ROAD' });
  assert.equal(JSON.stringify({ calls, result, status: await controller.referencesStatus() }).includes(key), false);
});

test('missing VWorld credentials emit a popup request without network calls or credential text', async t => {
  let apiCalls = 0; let saved = null;
  const { controller, setBehavior } = await setup(t, {
    referenceSecretStore: { read: async () => saved, write: async value => { saved = value; } },
    referenceApiFactory: () => ({ geocode: async () => { apiCalls++; throw Error('Unexpected network call'); } }),
  });
  const chat = (await controller.chatCreate()).chat;
  assert.equal((await controller.status()).credentialRequest, undefined);
  setBehavior(async () => {
    await assert.rejects(controller.callCad('geocode', { address: '서울특별시 중구 세종대로 110' }), /VWorld.*키/);
    const state = await controller.status();
    assert.equal(state.credentialRequest.provider, 'vworld');
    assert.equal(state.active, true);
    return { reply: 'VWorld API 키를 등록한 뒤 다시 요청해 주세요.' };
  });
  await controller.chat({ chatId: chat.id, message: '주소 조회', context, history: [] });
  const state = await controller.status();
  assert.equal(state.active, false); assert.match(state.credentialRequest.id, /^[a-f0-9-]{36}$/);
  assert.equal(apiCalls, 0);
  await controller.referencesSave({ apiKey: TEST_API_KEY });
  assert.equal((await controller.status()).credentialRequest, undefined);
});

test('model choice stays outside prompt data and streaming exposes only current public events', async t => {
  const { controller, calls, setBehavior, options } = await setup(t);
  const catalog = await controller.modelsList(); assert.equal(catalog.models[0].id, 'gpt-test');
  const events = [];
  setBehavior(async ({ config }) => {
    config.onEvent({type:'delta',text:'안녕하세요'});
    config.onEvent({type:'tool',id:'tool-1',server:'sitecad',name:'cad_query',status:'running',arguments:{token:TEST_PRIVATE_TOKEN},result:TEST_PRIVATE_TOKEN});
    config.onEvent({type:'reasoning',text:TEST_PRIVATE_TOKEN});
    return {reply:'안녕하세요'};
  });
  await controller.chat({message:'도면 조회',context,history:[],model:'gpt-test'}, {onEvent:event=>events.push(event)});
  assert.equal(calls[0].session.model,'gpt-test'); assert.equal(calls[0].input.model,undefined);
  assert.deepEqual(events,[{type:'delta',text:'안녕하세요'},{type:'tool',id:'tool-1',server:'sitecad',name:'cad_query',status:'running'}]);
  options().onEvent({type:'delta',text:'late reply'}); assert.equal(events.length,2);
  await assert.rejects(controller.chat({message:'도면 조회',context,history:[],model:{id:'bad'}}),/모델/);
});

test('plugin install approval, separate inventory, slash invocation and approved removal share the real controller flow', async t => {
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
  const files = { '.codex-plugin/plugin.json': JSON.stringify({ name: 'cad-tools', version: '1.0.0', skills: './skills/' }),
    'skills/review/SKILL.md': '---\nname: review\ndescription: Review drawing state.\n---\nRead actual cad_context and report without changing the drawing.' };
  const entries = Object.entries(files).map(([path, raw]) => ({ path, type: 'blob', mode: '100644', sha: createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex') }));
  const fetchImpl = async value => {
    const url = String(value);
    if (url.includes('/commits/')) return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    if (url.includes('/git/trees/')) return Response.json({ sha: tree, tree: entries, truncated: false });
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    return Object.hasOwn(files, path) ? new Response(files[path]) : new Response('', { status: 404 });
  };
  const { controller, calls, setBehavior } = await setup(t, { pluginFactory: options => createSitecadPlugins({ ...options, fetchImpl }) });
  async function approve(job, expectedKind) {
    let status;
    for (let i = 0; i < 1000; i++) { status = await controller.status(); if (status.approvals.length) break; await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.equal(status.approvals[0]?.kind, expectedKind);
    controller.resolveApproval({ id: status.approvals[0].id, approved: true }); return job;
  }
  setBehavior(async () => {
    const plan = await controller.callCad('manage_plugins', { action: 'inspect', url: 'https://github.com/example/cad-tools' });
    assert.ok(plan.planId);
    const installed = await approve(controller.callCad('manage_plugins', { action: 'install', planId: plan.planId }), 'plugin-install');
    assert.deepEqual(installed.skills, ['plugin-cad-tools-review']);
    return { reply: '/plugin-cad-tools-review 명령을 설치했습니다.' };
  });
  await controller.chat({ message: '이 플러그인을 설치해줘', context, history: [] });
  assert.deepEqual((await controller.pluginsList()).plugins.map(item => item.name), ['cad-tools']);
  assert.deepEqual((await controller.mcpList()).servers, []);
  assert.ok((await controller.skillsList()).skills.some(item => item.name === 'plugin-cad-tools-review'));
  setBehavior(() => ({ reply: '현재 도면 조회를 실행했습니다.' }));
  await controller.chat({ message: '/plugin-cad-tools-review 현재 도면', context, history: [] });
  assert.equal(calls.at(-1).session.skill.name, 'plugin-cad-tools-review');
  assert.match(calls.at(-1).session.skill.path, /codex-home\/skills\/plugin-cad-tools-review\/SKILL.md$/);
  setBehavior(async () => {
    await approve(controller.callCad('manage_plugins', { action: 'remove', name: 'cad-tools' }), 'plugin-remove');
    return { reply: '검증 플러그인을 제거했습니다.' };
  });
  await controller.chat({ message: '검증 플러그인 제거', context, history: [] });
  assert.deepEqual((await controller.pluginsList()).plugins, []);
  await assert.rejects(controller.chat({ message: '/plugin-cad-tools-review', context, history: [] }), /스킬/);
});
