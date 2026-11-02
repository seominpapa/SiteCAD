import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createApp } from '../server.mjs';

const context = { documentId: 1, revision: 0, units: 4, selection: [], entities: [] };
async function setup(t, { installFailure } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-mcp-credentials-'));
  let behavior = async () => ({ reply: '완료' }), stored = null;
  const runtimes = [], removed = [];
  const controller = await createDesktopController({ dataDir, nodePath: process.execPath, codexPath: '/fixture/codex', secureStore: {},
    mcpSecretStore: { read: async () => structuredClone(stored), write: async value => { stored = structuredClone(value); } },
    mcpInstaller: { inspect: async () => ({ planId: 'plan' }), install: async (input, { approve }) => {
      if (!await approve({ packageName: 'weather-mcp', version: '1.0.0' })) throw Error('승인 거절');
      if (installFailure) throw installFailure;
      return { config: { name: input.name, transport: 'stdio', command: '/fixture/node', args: ['/fixture/server.mjs'] }, installation: { id: 'package' } };
    }, remove: async id => removed.push(id) },
    authFactory: async () => ({ status: async () => ({ loggedIn: true, sharing: true }), getAccessToken: async () => 'token', close: async () => {} }),
    runtimeFactory: async config => {
      const calls = { config, stopped: false, tested: [] }; runtimes.push(calls);
      return { start: async () => {}, stop: async () => { calls.stopped = true; }, cancel: async () => {}, status: () => ({ connected: true }), chat: (...args) => behavior(...args),
        getMcpStatus: async () => config.externalServers.map(server => ({ name: server.name, status: 'connected', tools: ['search'] })),
        testExternal: async name => { calls.tested.push(name); return { name, status: 'connected', tested: true, tools: ['search'] }; } };
    } });
  await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
  t.after(async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { controller, dataDir, runtimes, removed, stored: () => stored, run: callback => { behavior = callback; } };
}
async function install(value, { remote = false, approve = true } = {}) {
  value.run(async () => {
    const pending = value.controller.callCad('manage_mcp', remote ? { action: 'add', name: 'remote', url: 'https://example.org/mcp', credentials: { bearerToken: true, issuanceUrl: 'https://example.org/keys' } } : { action: 'install', planId: 'plan', name: 'weather', credentials: { envKeys: ['WEATHER_API_KEY'], issuanceUrl: 'https://example.org/keys' } });
    let approval;
    for (let i = 0; i < 100; i++) {
      approval = (await value.controller.status()).approvals[0];
      if (approval) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(approval?.kind, 'mcp-install');
    value.controller.resolveApproval({ id: approval.id, approved: approve });
    const result = await pending;
    assert.equal(result.status, approve ? 'key_required' : 'error');
    return { reply: '설정 → API에서 키를 입력해 주세요.' };
  });
  return value.controller.chat({ message: '인증키가 필요한 MCP를 설치해줘', context, history: [] });
}

test('approved chat installation retains a key-required package and private exact key save enables the runtime', async t => {
  const value = await setup(t), key = 'private-weather-credential';
  const result = await install(value);
  assert.equal(result.installations[0].status, 'key_required');
  let server = (await value.controller.mcpList()).servers[0];
  assert.equal(server.name, 'weather'); assert.equal(server.credentialsRequired, true); assert.equal(server.enabled, false);
  assert.deepEqual(value.removed, []); assert.deepEqual(value.runtimes.flatMap(runtime => runtime.tested), []);
  assert.equal((await value.controller.status()).credentialRequest.provider, 'mcp');
  assert.equal((await value.controller.status()).credentialRequest.apiId, 'weather');
  await assert.rejects(value.controller.mcpToggle({ name: 'weather', enabled: true }), /인증/);
  await assert.rejects(value.controller.mcpCredentials({ name: 'weather', env: { OTHER_KEY: key }, trusted: true }));
  const saved = await value.controller.mcpCredentials({ name: 'weather', env: { WEATHER_API_KEY: key }, trusted: true });
  assert.equal(saved.credentialsSaved, true); assert.equal(saved.connected, false);
  assert.equal((await value.controller.status()).credentialRequest, undefined);
  assert.equal(value.runtimes[0].stopped, true);
  server = (await value.controller.mcpList()).servers[0];
  assert.equal(server.credentialsRequired, false); assert.equal(server.enabled, true);
  await value.controller.mcpTest({ name: 'weather' });
  assert.equal(value.runtimes.at(-1).config.externalServers[0].env.WEATHER_API_KEY, key);
  assert.equal((await value.controller.mcpList()).servers[0].connected, true);
  assert.equal(JSON.stringify(value.stored()).includes(key), true);
  for (const publicValue of [saved, result, await value.controller.status(), await value.controller.mcpList(), await readFile(join(value.dataDir, 'external-mcp.json'), 'utf8'), await readFile(join(value.dataDir, 'installation-results.json'), 'utf8')]) assert.equal(JSON.stringify(publicValue).includes(key), false);
});

test('HTTP bearer auth uses the same private path and cannot change server identity or credentials metadata', async t => {
  const value = await setup(t), key = 'private-http-credential';
  await install(value, { remote: true });
  for (const input of [{ name: 'remote', bearerToken: key }, { name: 'remote', bearerToken: key, trusted: true, url: 'https://evil.example/mcp' }, { name: 'remote', env: { KEY: key }, trusted: true }, { name: 'remote', bearerToken: 'spoof\nheader', trusted: true }]) await assert.rejects(value.controller.mcpCredentials(input));
  await value.controller.mcpCredentials({ name: 'remote', bearerToken: key, trusted: true });
  await value.controller.mcpTest({ name: 'remote' });
  assert.equal(value.runtimes.at(-1).config.externalServers[0].bearerToken, key);
  assert.equal(JSON.stringify(await value.controller.status()).includes(key), false);
});

test('approved direct installation also retains credential requirements without testing an unauthenticated package', async t => {
  const value = await setup(t);
  const result = await value.controller.mcpInstall({ planId: 'plan', name: 'weather', approved: true, credentials: { envKeys: ['WEATHER_API_KEY'], issuanceUrl: 'https://example.org/keys' } });
  assert.equal(result.status, 'key_required'); assert.equal(result.connected, false);
  assert.deepEqual(value.runtimes, []); assert.deepEqual(value.removed, []);
  const state = await value.controller.mcpList();
  assert.equal(state.servers[0].enabled, false);
  assert.equal(state.installationResults[0].status, 'key_required');
  await value.controller.mcpCredentials({ name: 'weather', env: { WEATHER_API_KEY: 'test-direct-key' }, trusted: true });
  await value.controller.mcpTest({ name: 'weather' });
  assert.equal(value.runtimes[0].config.externalServers[0].env.WEATHER_API_KEY, 'test-direct-key');
});

test('a direct installation network or integrity failure persists exactly one safe failed outcome', async t => {
  const failure = Error('npm network integrity rejected private-debug-value');
  const value = await setup(t, { installFailure: failure });
  await assert.rejects(value.controller.mcpInstall({ planId: 'plan', name: 'weather', approved: true }), /integrity/);
  const state = await value.controller.mcpList();
  assert.deepEqual(state.servers, []);
  assert.equal(state.installationResults.length, 1);
  assert.equal(state.installationResults[0].status, 'failed');
  assert.equal(state.installationResults[0].name, 'weather');
  assert.equal(JSON.stringify(state.installationResults).includes('private-debug-value'), false);
  assert.equal((await readFile(join(value.dataDir, 'installation-results.json'), 'utf8')).includes('private-debug-value'), false);
  assert.deepEqual(value.runtimes, []);
});

test('refused installation never creates a key field and busy or closed settings refuse credentials', async t => {
  const value = await setup(t);
  await install(value, { approve: false });
  assert.deepEqual((await value.controller.mcpList()).servers, []);
  assert.equal((await value.controller.status()).credentialRequest, undefined);
  await install(value);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  value.run(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { reply: '완료' }; });
  const turn = value.controller.chat({ message: '작업 중', context, history: [] }); await ready;
  await assert.rejects(value.controller.mcpCredentials({ name: 'weather', env: { WEATHER_API_KEY: 'test-key' }, trusted: true }), /작업/);
  release(); await turn;
  await value.controller.close();
  await assert.rejects(value.controller.mcpCredentials({ name: 'weather', env: { WEATHER_API_KEY: 'test-key' }, trusted: true }), /작업/);
});

test('private MCP credentials route requires JSON and the current local app origin', async t => {
  const calls = [];
  const app = createApp({ desktop: { mcpCredentials: async input => { calls.push(input); return { credentialsSaved: true, connected: false }; } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`, url = `${base}/api/desktop/mcp/credentials`;
  const input = { name: 'remote', bearerToken: 'private-route-key', trusted: true };
  const request = headers => fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await request({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await request({ Origin: 'https://foreign.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await request({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
  const response = await request({ Origin: base, 'Content-Type': 'application/json' });
  assert.equal(response.status, 200); assert.deepEqual(calls, [input]);
  assert.equal(JSON.stringify(await response.json()).includes(input.bearerToken), false);
});
