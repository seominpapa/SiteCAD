import test from 'node:test';
import assert from 'node:assert/strict';
import { createSitecadExtensions } from '../lib/sitecad-extensions.mjs';

function fixture(decision = 'approve') {
  const approvals = [], installed = [], removed = [];
  const skills = { list: async () => [{name:'skill-creator'}], find: async query => [query], read: async name => ({name,hash:'old',body:'steps'}), save: async value => value };
  const installer = { inspect: async url => ({planId:'plan',repository:url}), install: async (value,{approve}) => {
    if (!await approve({packageName:'@example/tool',version:'1.0.0'})) throw Error('설치를 승인하지 않았습니다.');
    installed.push(value); return {config:{name:value.name,transport:'stdio',command:'/app/node',args:['/private/tool.mjs']},installation:{id:'install',status:'installed_pending_connection'}};
  }, remove: async id => removed.push(id) };
  const registry = { list: async () => [{name:'existing'}] };
  const api = createSitecadExtensions({skills,installer,registry,onApproval:async value => {approvals.push(value); return decision;},isCurrent:()=>true,getSignal:()=>new AbortController().signal,getConversation:async()=>[{role:'user',text:'이 대화를 스킬로'}]});
  return {api,approvals,installed,removed};
}
test('managed MCP install waits for consent, stages registration, and cleanup removes unused files',async()=>{
  const t=fixture();
  assert.equal((await t.api.call('manage_mcp',{action:'inspect',url:'https://github.com/example/tool'})).planId,'plan');
  const result=await t.api.call('manage_mcp',{action:'install',planId:'plan',name:'sample'});
  assert.equal(result.status,'installed_pending_connection');
  assert.equal(t.approvals[0].kind,'mcp-install');
  assert.equal(t.api.pending().length,1);
  assert.equal(t.api.pending()[0].config.name,'sample');
  await t.api.discard(); assert.deepEqual(t.removed,['install']);
});
test('declined, duplicate and unexpected management requests cannot stage a new MCP',async()=>{
  const t=fixture('deny');
  await assert.rejects(t.api.call('manage_mcp',{action:'install',planId:'plan',name:'sample'}),/승인/);
  await assert.rejects(t.api.call('manage_mcp',{action:'install',planId:'plan',name:'existing'}),/등록/);
  await assert.rejects(t.api.call('manage_mcp',{action:'install',planId:'plan',name:'sample',command:'/bin/sh'}),/입력/);
  assert.deepEqual(t.installed,[]); assert.deepEqual(t.api.pending(),[]);
});
test('skill overwrite binds approval to actual hash and conversation access is read only',async()=>{
  const t=fixture();
  const result=await t.api.call('manage_skills',{action:'save',name:'my-skill',description:'작업',body:'steps',expectedHash:'old'});
  assert.equal(result.name,'my-skill'); assert.equal(t.approvals[0].kind,'skill-overwrite');
  await assert.rejects(t.api.call('manage_skills',{action:'save',name:'my-skill',description:'작업',body:'steps',expectedHash:'stale'}),/변경/);
  assert.equal((await t.api.call('manage_skills',{action:'conversation'})).messages[0].role,'user');
  assert.deepEqual((await t.api.call('manage_skills',{action:'list'})).skills,[{name:'skill-creator'}]);
});
test('approved HTTPS servers stage while bundled presets are unavailable',async()=>{
  const t=fixture();
  await assert.rejects(t.api.call('manage_mcp',{action:'add',name:'rea',preset:'rea'}),/입력|HTTPS/);
  await t.api.call('manage_mcp',{action:'add',name:'remote',url:'https://example.org/mcp'});
  assert.deepEqual(t.api.pending().map(item=>item.config.name),['remote']);
  await assert.rejects(t.api.call('manage_mcp',{action:'add',name:'bad',url:'http://example.org/mcp'}),/HTTPS/);
});

test('explicit user installation may use the name rea through the generic approved installer',async()=>{
  const t=fixture();
  await t.api.call('manage_mcp',{action:'install',planId:'plan',name:'rea'});
  assert.equal(t.api.pending()[0].config.name,'rea');
  assert.equal(t.approvals[0].kind,'mcp-install');
});

test('plugins use a separate approved installer and never stage an external MCP', async () => {
  const approvals = [], installed = [];
  const plugins = { list: async () => [], read: async name => ({ name }), inspect: async url => ({ planId: 'plugin-plan', repository: url }),
    async install(value, { approve }) { if (!await approve({ name: 'example', skills: [{ body: 'source instruction' }] })) throw Error('승인 거절'); installed.push(value); return { name: 'example', status: 'installed', commands: ['/plugin-example-check'] }; } };
  let current = true;
  const api = createSitecadExtensions({ plugins, onApproval: async value => { approvals.push(value); return current ? 'approve' : 'deny'; }, isCurrent: () => true, getSignal: () => undefined });
  assert.deepEqual(await api.call('manage_plugins', { action: 'list' }), { plugins: [] });
  assert.equal((await api.call('manage_plugins', { action: 'inspect', url: 'https://github.com/example/plugins' })).planId, 'plugin-plan');
  assert.equal((await api.call('manage_plugins', { action: 'read', name: 'example' })).name, 'example');
  assert.equal((await api.call('manage_plugins', { action: 'install', planId: 'plugin-plan' })).status, 'installed');
  assert.equal(approvals[0].kind, 'plugin-install'); assert.deepEqual(installed, [{ planId: 'plugin-plan' }]); assert.deepEqual(api.pending(), []);
  await assert.rejects(api.call('manage_plugins', { action: 'install', planId: 'plugin-plan', command: 'shell' }), /입력/);
  await assert.rejects(api.call('manage_plugins', { action: 'unknown' }), /입력/);
  current = false; await assert.rejects(api.call('manage_plugins', { action: 'install', planId: 'plugin-plan' }), /승인/);
});
