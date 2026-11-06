import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmConnections } from '../lib/llm-connections.mjs';

const TEST_OTHER_ANTHROPIC_KEY = 'sk-ant-another-secret-12345';
const TEST_PARALLEL_ANTHROPIC_KEY = 'sk-ant-parallel-secret-12345';

const key = 'sk-test-secret-123456789';
function setup(options = {}) {
  let saved = null; let signedIn = true;
  const requests = [];
  const store = { read: async () => saved, write: async value => { saved = structuredClone(value); }, remove: async () => { saved = null; } };
  const oauth = { status: async () => ({ loggedIn: signedIn, sharing: signedIn }), login: async () => ({ pending: true }), logout: async () => { signedIn = false; }, getAccessToken: async () => 'private-openai-access-token' };
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ data: [{ id: 'some-model' }] })); };
  const manager = createLlmConnections({ store, oauth, dataDir: '/private/tmp/sitecad-llm-test', claudePath: null, fetchImpl, ...options });
  return { manager, saved: () => saved, store, oauth, requests };
}

test('default connection preserves existing OpenAI OAuth and public status excludes tokens', async () => {
  const { manager } = setup();
  const status = await manager.status();
  assert.equal(status.active, 'openai-oauth');
  assert.equal(status.connected, true);
  assert.equal(status.connections.length, 4);
  assert.equal(status.anthropicOAuth.available, false);
  assert.equal((await manager.credentials()).accessToken, 'private-openai-access-token');
  assert.doesNotMatch(JSON.stringify(status), /private-openai-access-token|apiKey|refreshToken/);
});

test('API keys persist only through the encrypted store and selection survives manager recreation', async () => {
  const { manager, store, oauth, saved } = setup();
  const status = await manager.save({ id: 'openai-api', apiKey: key });
  assert.equal(saved().keys['openai-api'].apiKey, key);
  assert.equal(status.active, 'openai-oauth');
  const selected = await manager.select({ id: 'openai-api' });
  assert.equal(selected.connected, true);
  assert.doesNotMatch(JSON.stringify(selected), /sk-test-secret/);
  const next = createLlmConnections({ store, oauth, dataDir: '/private/tmp/sitecad-llm-test', claudePath: null });
  assert.equal(await next.activeId(), 'openai-api');
  assert.deepEqual(await next.credentials(), { id: 'openai-api', provider: 'openai', method: 'api', apiKey: key });
});

test('saving and testing Anthropic uses fixed models endpoint, optional workspace header and no paid inference', async () => {
  const { manager, requests } = setup();
  await manager.save({ id: 'anthropic-api', apiKey: key, workspaceId: 'wrkspc_sitecad123' });
  const result = await manager.test({ id: 'anthropic-api' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/models');
  assert.equal(requests[0].init.headers['x-api-key'], key);
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers['anthropic-workspace-id'], 'wrkspc_sitecad123');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.method, 'GET');
  assert.doesNotMatch(JSON.stringify(result), /sk-test-secret/);
});

test('OpenAI connection checks only models and sanitizes HTTP and network failures', async () => {
  for (const failure of [() => new Response('secret backend body', { status: 401 }), () => new Response('rate limit', { status: 429 }), () => { throw Error(`Authorization ${key}`); }]) {
    const { manager } = setup({ fetchImpl: async () => failure() });
    await manager.save({ id: 'openai-api', apiKey: key });
    const result = await manager.test({ id: 'openai-api' });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify({ result, status: await manager.status() }), /sk-test-secret|secret backend body|Authorization/);
  }
});

test('connection checks reject malformed or oversized model responses', async () => {
  for (const body of ['null', '{}', '{invalid', JSON.stringify({ data: [{ id: key }], padding: 'a'.repeat(1100000) })]) {
    const { manager } = setup({ fetchImpl: async () => new Response(body) });
    await manager.save({ id: 'openai-api', apiKey: key });
    assert.equal((await manager.test({ id: 'openai-api' })).ok, false);
  }
});

test('exact input validation rejects injected IDs, headers, paths and invalid key characters', async () => {
  const { manager, saved } = setup();
  for (const input of [null, [], {}, { id: 'openai-api', apiKey: '' }, { id: 'anthropic-api', apiKey: `${key}\nheader` }, { id: 'openai-oauth', apiKey: key }, { id: 'openai-api', apiKey: key, baseUrl: 'https://attacker.example' }, { id: 'openai-api', apiKey: key, workspaceId: 'wrkspc_test' }, { id: 'anthropic-api', apiKey: key, workspaceId: 'bad' }]) await assert.rejects(manager.save(input));
  for (const input of [{ id: 'unknown' }, { id: 'openai-api', extra: true }, { id: '../credentials' }, []]) await assert.rejects(manager.select(input));
  assert.equal(saved(), null);
});

test('unconfigured selection is rejected, removing an active API selects existing OAuth without destroying other keys', async () => {
  const { manager, saved } = setup();
  await assert.rejects(manager.select({ id: 'openai-api' }));
  await manager.save({ id: 'openai-api', apiKey: key });
  await manager.save({ id: 'anthropic-api', apiKey: TEST_OTHER_ANTHROPIC_KEY });
  await manager.select({ id: 'openai-api' });
  await manager.remove({ id: 'openai-api' });
  assert.equal(await manager.activeId(), 'openai-oauth');
  assert.equal(saved().keys['openai-api'], undefined);
  assert.equal(saved().keys['anthropic-api'].apiKey, TEST_OTHER_ANTHROPIC_KEY);
});

test('storage failures and malformed persisted records never expose stored secrets', async () => {
  for (const store of [{ read: async () => { throw Error(key); } }, { read: async () => ({ version: 1, active: '../unsafe', keys: { injected: key } }) }]) {
    const { manager } = setup({ store });
    await assert.rejects(manager.status(), error => !error.message.includes(key));
  }
  const { manager } = setup({ store: { read: async () => null, write: async () => { throw Error(key); } } });
  await assert.rejects(manager.save({ id: 'openai-api', apiKey: key }), error => !error.message.includes(key));
});

test('Claude OAuth delegates to official Claude Code without reading subscription credentials', async () => {
  let loggedIn = false; const calls = [];
  const claudeCodeAuth = {
    status: async () => ({ available: true, loggedIn, pending: false }),
    login: async () => { calls.push('login'); loggedIn = true; return { pending: false }; },
    logout: async () => { calls.push('logout'); loggedIn = false; },
    cancel: async () => { calls.push('cancel'); },
    runtimeOptions: async () => ({ claudePath: '/official/claude', claudeConfigDir: '/private/app/claude-code' }),
  };
  const { manager, requests } = setup({ claudeCodeAuth });
  assert.equal((await manager.status()).connections.find(item => item.id === 'anthropic-oauth').configured, false);
  await manager.login({ id: 'anthropic-oauth' });
  await manager.select({ id: 'anthropic-oauth' });
  assert.equal((await manager.status()).label, 'Claude · OAuth(구독)');
  await assert.rejects(manager.credentials(), /공식 Claude Code/);
  assert.deepEqual(await manager.claudeCodeRuntimeOptions(), { claudePath: '/official/claude', claudeConfigDir: '/private/app/claude-code' });
  assert.equal((await manager.test({ id: 'anthropic-oauth' })).ok, true);
  assert.equal(requests.length, 0, 'subscription auth is never sent directly to API');
  await manager.remove({ id: 'anthropic-oauth' });
  assert.equal(await manager.activeId(), 'openai-oauth');
  assert.deepEqual(calls, ['login', 'cancel', 'logout']);
});

test('legacy Console OAuth marker is dormant and never means Claude Code signed in', async () => {
  const record = { version: 1, active: 'anthropic-oauth', keys: {}, anthropicOAuth: true };
  const { manager } = setup({ store: { read: async () => record } });
  assert.equal((await manager.status()).connected, false);
  assert.equal((await manager.test({ id: 'anthropic-oauth' })).ok, false);
  await assert.rejects(manager.select({ id: 'anthropic-oauth' }));
  const result = await manager.login({ id: 'anthropic-oauth' });
  assert.equal(result.actionNeeded, 'install-claude-code');
  assert.equal(result.installUrl, 'https://code.claude.com/docs/en/quickstart');
});

test('simultaneous key saves preserve both connections without changing the selected provider', async () => {
  const { manager, saved } = setup();
  await Promise.all([manager.save({ id: 'openai-api', apiKey: key }), manager.save({ id: 'anthropic-api', apiKey: TEST_PARALLEL_ANTHROPIC_KEY })]);
  assert.equal(saved().keys['openai-api'].apiKey, key);
  assert.equal(saved().keys['anthropic-api'].apiKey, TEST_PARALLEL_ANTHROPIC_KEY);
  assert.equal(await manager.activeId(), 'openai-oauth');
});

test('OpenAI OAuth login and logout use the existing protected account manager', async () => {
  const { manager } = setup();
  assert.equal((await manager.login({ id: 'openai-oauth' })).active, 'openai-oauth');
  assert.equal((await manager.remove({ id: 'openai-oauth' })).connected, false);
  await assert.rejects(manager.credentials());
  await assert.rejects(manager.login({ id: 'openai-api' }));
});
