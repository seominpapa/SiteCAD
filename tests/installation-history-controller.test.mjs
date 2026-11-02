import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const context = { documentId: 1, revision: 0, units: 4, selection: [], entities: [] };
async function setup(t, { connected = true, pluginFailure = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-install-controller-'));
  let behavior = async () => ({ reply: '완료' });
  const controller = await createDesktopController({ dataDir, nodePath: process.execPath, codexPath: '/fixture/codex', secureStore: {},
    authFactory: async () => ({ status: async () => ({ loggedIn: true, sharing: true }), getAccessToken: async () => 'token', close: async () => {} }),
    pluginFactory: () => ({ list: async () => [], install: async () => { if (pluginFailure) throw Error('private-install-failure'); return { name: 'cad-tools', status: 'installed' }; } }),
    runtimeFactory: async ({ externalServers }) => ({ start: async () => {}, stop: async () => {}, cancel: async () => {}, status: () => ({ connected: true }),
      getMcpStatus: async () => externalServers.map(server => ({ name: server.name, status: connected ? 'connected' : 'failed' })),
      testExternal: async name => ({ name, status: connected ? 'connected' : 'failed', tested: true, tools: connected ? ['inspect'] : [] }),
      chat: (...args) => behavior(...args) }) });
  await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
  t.after(async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { controller, dataDir, run: callback => { behavior = callback; } };
}
async function installMcp(value) {
  value.run(async () => {
    const pending = value.controller.callCad('manage_mcp', { action: 'add', name: 'remote', url: 'https://example.org/mcp' });
    let approval;
    for (let i = 0; i < 100; i++) {
      approval = (await value.controller.status()).approvals[0];
      if (approval) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(approval?.kind, 'mcp-install');
    await value.controller.resolveApproval({ id: approval.id, approved: true });
    await pending;
    return { reply: '설치 연결 확인' };
  });
  return value.controller.chat({ message: '외부 MCP 연결해줘', context, history: [] });
}
test('successful and rolled back MCP installations remain in their settings history', async t => {
  for (const connected of [true, false]) {
    const value = await setup(t, { connected });
    const result = await installMcp(value), state = await value.controller.mcpList();
    assert.equal(result.installations[0].status, connected ? 'connected' : 'failed');
    assert.equal(state.servers.length, connected ? 1 : 0);
    assert.equal(state.installationResults[0].status, connected ? 'connected' : 'failed');
    assert.equal(state.installationResults[0].name, 'remote');
    assert.deepEqual((await value.controller.pluginsList()).installationResults, []);
  }
});
test('a damaged history store reports a warning without changing a completed install outcome', async t => {
  const value = await setup(t);
  await writeFile(join(value.dataDir, 'installation-results.json'), '{corrupt');
  const result = await installMcp(value), state = await value.controller.mcpList();
  assert.equal(result.installations[0].status, 'connected');
  assert.equal(state.servers[0].connected, true);
  assert.deepEqual(state.installationResults, []);
  assert.match(state.installationHistoryWarning, /설치 결과 기록/);
});
test('settings plugin installation records outcomes without persisting private failure text', async t => {
  for (const pluginFailure of [false, true]) {
    const value = await setup(t, { pluginFailure });
    const pending = value.controller.pluginsInstall({ planId: 'reviewed-plan', approved: true });
    if (pluginFailure) await assert.rejects(pending); else assert.equal((await pending).status, 'installed');
    const state = await value.controller.pluginsList();
    assert.equal(state.installationResults[0].status, pluginFailure ? 'failed' : 'installed');
    assert.doesNotMatch(JSON.stringify(state), /private-install-failure/);
  }
});
