import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmConnections } from '../lib/llm-connections.mjs';

const TEST_OTHER_ANTHROPIC_KEY = 'sk-ant-another-secret-12345';
const TEST_PARALLEL_ANTHROPIC_KEY = 'sk-ant-parallel-secret-12345';

const key = 'sk-test-secret-123456789';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(options = {}) {
  let saved = null; let signedIn = true;
  const requests = [];
  const store = { read: async () => saved, write: async value => { saved = structuredClone(value); }, remove: async () => { saved = null; } };
  const oauth = { status: async () => ({ loggedIn: signedIn, sharing: signedIn }), login: async () => ({ pending: true }), logout: async () => { signedIn = false; }, getAccessToken: async () => 'private-openai-access-token' };
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ data: [{ id: 'some-model' }] })); };
  const manager = createLlmConnections({ store, oauth, dataDir: '/private/tmp/sitecad-llm-test', antPath: null, fetchImpl, ...options });
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
  const next = createLlmConnections({ store, oauth, dataDir: '/private/tmp/sitecad-llm-test', antPath: null });
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

test('missing Anthropic CLI gives official install action and never invokes a shell', async () => {
  let calls = 0;
  const { manager } = setup({ executeImpl: async () => { calls++; } });
  const result = await manager.login({ id: 'anthropic-oauth' });
  assert.equal(result.actionNeeded, 'install-anthropic-cli');
  assert.equal(result.installUrl, 'https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart');
  assert.equal(calls, 0);
});

async function withCli(task) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-ant-'));
  const path = join(directory, process.platform === 'win32' ? 'ant.exe' : 'ant');
  await writeFile(path, 'test fixture'); await chmod(path, 0o700);
  try { await task(path, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Console OAuth uses dedicated CLI profile, background login and ephemeral tokens only', async () => withCli(async (antPath, dataDir) => {
  const calls = [];
  const { manager, saved, requests } = setup({ antPath, dataDir, executeImpl: async (command, args, options) => {
    if (args[0] === '--help') return { stdout: 'CLI for the Claude Developer Platform' };
    calls.push({ command, args, options });
    if (args[1] === 'print-credentials') return { stdout: 'private-anthropic-access-token\n' };
    return { stdout: 'account secret must not escape' };
  } });
  const started = await manager.login({ id: 'anthropic-oauth' });
  assert.equal(started.pending, true);
  for (let n = 0; n < 20 && (await manager.status()).pending; n++) await tick();
  assert.equal((await manager.status()).connections.find(item => item.id === 'anthropic-oauth').configured, true);
  await manager.select({ id: 'anthropic-oauth' });
  assert.equal((await manager.credentials()).accessToken, 'private-anthropic-access-token');
  assert.equal((await manager.test({ id: 'anthropic-oauth' })).ok, true);
  assert.equal(requests[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(calls[0].args, ['auth', 'login', '--profile', 'sitecad']);
  assert.equal(calls[0].command, await realpath(antPath));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.ANTHROPIC_CONFIG_DIR, join(dataDir, 'anthropic-cli'));
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify({ saved: saved(), status: await manager.status(), started }), /private-anthropic|account secret/);
}));

test('cancelling OAuth aborts official login and cannot publish a late success', async () => withCli(async (antPath, dataDir) => {
  let finish, markStarted, signal;
  const started = new Promise(resolve => { markStarted = resolve; });
  const { manager } = setup({ antPath, dataDir, executeImpl: async (command, args, options) => args[0] === '--help' ? { stdout: 'CLI for the Claude Developer Platform' } : new Promise(resolve => { signal = options.signal; finish = () => resolve({ stdout: '' }); markStarted(); }) });
  await manager.login({ id: 'anthropic-oauth' });
  await started;
  await manager.cancel();
  assert.equal(signal.aborted, true);
  finish(); await tick();
  const status = await manager.status();
  assert.equal(status.pending, false);
  assert.equal(status.connections.find(item => item.id === 'anthropic-oauth').configured, false);
}));

test('OAuth errors are generic and selected key state stays unchanged', async () => withCli(async (antPath, dataDir) => {
  const { manager } = setup({ antPath, dataDir, executeImpl: async (command, args) => { if (args[0] === '--help') return { stdout: 'CLI for the Claude Developer Platform' }; throw Error(key); } });
  await manager.login({ id: 'anthropic-oauth' });
  for (let n = 0; n < 20 && (await manager.status()).pending; n++) await tick();
  assert.doesNotMatch(JSON.stringify(await manager.status()), /sk-test-secret/);
  assert.equal(await manager.activeId(), 'openai-oauth');
}));

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

test('removing Console OAuth logs out only the dedicated official CLI profile', async () => withCli(async (antPath, dataDir) => {
  const calls = [];
  const { manager, saved } = setup({ antPath, dataDir, executeImpl: async (command, args) => { if (args[0] === '--help') return { stdout: 'CLI for the Claude Developer Platform' }; calls.push(args); return { stdout: '' }; } });
  await manager.login({ id: 'anthropic-oauth' });
  for (let n = 0; n < 20 && (await manager.status()).pending; n++) await tick();
  await manager.select({ id: 'anthropic-oauth' });
  const result = await manager.remove({ id: 'anthropic-oauth' });
  assert.deepEqual(calls.at(-1), ['auth', 'logout', '--profile', 'sitecad']);
  assert.equal(result.active, 'openai-oauth');
  assert.equal(saved().anthropicOAuth, false);
}));

test('missing official CLI cannot falsely claim an existing Console OAuth profile was logged out', async () => {
  const store = { read: async () => ({ version: 1, active: 'anthropic-oauth', keys: {}, anthropicOAuth: true }), write: async () => { throw Error('must not silently remove'); } };
  const { manager } = setup({ store });
  await assert.rejects(manager.remove({ id: 'anthropic-oauth' }), /공식 CLI/);
  assert.equal((await manager.status()).connections.find(item => item.id === 'anthropic-oauth').configured, true);
});


test('Apache Ant executable collision is not accepted as Anthropic CLI and identity check is cached', async () => withCli(async (antPath, dataDir) => {
  let calls = 0;
  const { manager } = setup({ antPath, dataDir, executeImpl: async () => { calls++; return { stdout: 'Apache Ant(TM) version 1.10.15' }; } });
  assert.equal((await manager.status()).anthropicOAuth.available, false);
  assert.equal((await manager.status()).anthropicOAuth.available, false);
  assert.equal(calls, 1);
}));


test('status rediscovers a newly installed official CLI without restarting the app', async () => withCli(async (antPath, dataDir) => {
  await rm(antPath);
  let calls = 0;
  const { manager } = setup({ antPath, dataDir, executeImpl: async () => { calls++; return { stdout: 'CLI for the Claude Developer Platform' }; } });
  assert.equal((await manager.status()).anthropicOAuth.available, false);
  await writeFile(antPath, 'installed fixture'); await chmod(antPath, 0o700);
  assert.equal((await manager.status()).anthropicOAuth.available, true);
  assert.equal((await manager.status()).anthropicOAuth.available, true);
  assert.equal(calls, 1, 'unchanged official binary identity is cached');
}));
