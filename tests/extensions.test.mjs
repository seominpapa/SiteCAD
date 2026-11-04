import test from 'node:test';
import assert from 'node:assert/strict';
import { createSitecadExtensions } from '../lib/sitecad-extensions.mjs';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
test('feedback changes preserve real custom skill content until exact-hash overwrite approval and keep builtin copies separate', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'sitecad-feedback-skills-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const skills = await createSitecadSkills({ codexHome });
  await skills.seed();
  await skills.save({ name: 'my-quantity-review', description: '사용자 물량 검토', body: '기존 처리 절차' });
  const original = await skills.read('my-quantity-review');
  const approvals = [];
  let decision = 'deny';
  const api = createSitecadExtensions({ skills, onApproval: async proposal => { approvals.push(proposal); return decision; }, isCurrent: () => true, getSignal: () => undefined });
  const update = { action: 'save', name: original.name, description: original.description, body: '사용자가 요청한 수정 절차', expectedHash: original.hash };
  await assert.rejects(api.call('manage_skills', update), /승인/);
  assert.equal((await skills.read(original.name)).body, original.body);
  assert.equal(approvals[0].arguments.body, update.body);
  assert.equal(approvals[0].arguments.expectedHash, original.hash);
  decision = 'approve';
  const saved = await api.call('manage_skills', update);
  assert.equal(saved.command, '/my-quantity-review');
  assert.equal((await skills.read(original.name)).body, update.body);
  await assert.rejects(api.call('manage_skills', update), /변경/);
  assert.equal(approvals.length, 2, 'A stale hash must fail before requesting another approval.');
  const builtin = await skills.read('quantity-review');
  const copy = await api.call('manage_skills', { action: 'save', name: 'my-quantity-copy', description: '사용자 지정 물량 검토', body: `${builtin.body}\n사용자가 승인한 추가 처리 규칙` });
  assert.equal(copy.builtin, false);
  assert.equal(copy.command, '/my-quantity-copy');
  assert.equal((await skills.read(builtin.name)).hash, builtin.hash);
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

test('API registration reviews metadata, persists only after consent and never takes credentials', async () => {
  const approvals = [], registered = [];
  let current = true, decision = 'approve';
  const input = { action: 'register', id: 'weather', name: 'Weather', url: 'https://example.org/docs', issuanceUrl: 'https://example.org/keys' };
  const apis = { list: async () => ({ apis: [] }), register: async proposal => { registered.push(proposal); return { status: 'key_required', apiId: proposal.id }; } };
  const api = createSitecadExtensions({ apis, onApproval: async proposal => { approvals.push(proposal); return decision; }, isCurrent: () => current, getSignal: () => undefined });
  assert.deepEqual(await api.call('manage_apis', { action: 'list' }), { apis: [] });
  assert.equal((await api.call('manage_apis', { action: 'request', id: 'kcsc' })).settingsTarget, 'api');
  assert.equal((await api.call('manage_apis', input)).apiId, 'weather');
  assert.equal(approvals[0].kind, 'api-register');
  assert.deepEqual(registered[0], { id: 'weather', name: 'Weather', url: 'https://example.org/docs', issuanceUrl: 'https://example.org/keys' });
  for (const value of [{ ...input, apiKey: 'test-key' }, { ...input, issuanceUrl: 'https://evil.example/keys' }, { action: 'save', id: 'weather', apiKey: 'secret' }, { action: 'remove', id: 'weather' }]) await assert.rejects(api.call('manage_apis', value));
  assert.equal(approvals.length, 1);
  decision = 'deny'; await assert.rejects(api.call('manage_apis', input), /승인/);
  assert.equal(registered.length, 1);
  decision = 'approve'; current = false; await assert.rejects(api.call('manage_apis', input), /취소/);
  assert.equal(registered.length, 1);
});

test('chat MCP credential requirements are reviewed as metadata and retain an installed pending server', async () => {
  const t = fixture();
  const credentials = { envKeys: ['WEATHER_API_KEY'], issuanceUrl: 'https://example.org/keys' };
  const result = await t.api.call('manage_mcp', { action: 'install', planId: 'plan', name: 'weather', credentials });
  assert.equal(result.status, 'key_required');
  assert.equal(result.apiId, 'weather');
  assert.deepEqual(t.api.pending()[0].config.credentialRequirements.envKeys, ['WEATHER_API_KEY']);
  assert.equal(t.api.pending()[0].config.enabled, false);
  assert.deepEqual(t.approvals[0].arguments.credentials.envKeys, ['WEATHER_API_KEY']);
  assert.equal(t.installed.length, 1);
  const remote = await t.api.call('manage_mcp', { action: 'add', name: 'remote', url: 'https://example.org/mcp', credentials: { bearerToken: true } });
  assert.equal(remote.status, 'key_required');
  assert.equal(t.api.pending()[1].config.credentialRequirements.bearerToken, true);
  for (const input of [{ action: 'add', name: 'bad', url: 'https://example.org/mcp', credentials: { bearerToken: 'secret-value' } }, { action: 'install', name: 'bad', planId: 'plan', credentials: { envKeys: ['NODE_OPTIONS'] } }, { action: 'install', name: 'bad', planId: 'plan', credentials: { env: { KEY: 'secret-value' } } }]) await assert.rejects(t.api.call('manage_mcp', input));
  assert.equal(t.installed.length, 1);
  assert.equal(t.approvals.length, 2);
});

test('an approved package download or integrity rejection records one failed installation before registration', async () => {
  const outcomes = [];
  const api = createSitecadExtensions({
    installer: { install: async (_, { approve }) => { await approve({ packageName: 'example-mcp' }); throw Error('npm download integrity rejected'); } },
    registry: { list: async () => [] },
    onInstallationResult: async outcome => outcomes.push(outcome),
    onApproval: async () => 'approve', isCurrent: () => true, getSignal: () => undefined,
  });
  await assert.rejects(api.call('manage_mcp', { action: 'install', planId: 'plan', name: 'example' }), /integrity/);
  assert.deepEqual(outcomes, [{ kind: 'mcp', name: 'example', status: 'failed' }]);
  assert.deepEqual(api.pending(), []);
});
