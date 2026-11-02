import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const TEST_API_KEY = 'private-api-value';

const context = { documentId: 1, revision: 0, units: 4, selection: [], entities: [] };
const registration = { action: 'register', id: 'weather', name: '날씨 API', url: 'https://example.org/api', issuanceUrl: 'https://example.org/keys' };
async function setup(t, { secure = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-api-chat-'));
  let behavior = async () => ({ reply: '완료' }), saved;
  const controller = await createDesktopController({ dataDir, nodePath: process.execPath, codexPath: '/fixture/codex', secureStore: {},
    ...(secure ? { apiSecretStore: { read: async () => saved ?? null, write: async value => { saved = structuredClone(value); } } } : {}),
    authFactory: async () => ({ status: async () => ({ loggedIn: true, sharing: true }), getAccessToken: async () => 'token', close: async () => {} }),
    runtimeFactory: async () => ({ start: async () => {}, stop: async () => {}, cancel: async () => {}, status: () => ({ connected: true }), chat: (...args) => behavior(...args) }) });
  await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
  t.after(async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { controller, dataDir, saved: () => saved, run: value => { behavior = value; } };
}
async function register(value) {
  value.run(async () => {
    const pending = value.controller.callCad('manage_apis', registration);
    let approval;
    for (let i = 0; i < 100; i++) {
      approval = (await value.controller.status()).approvals[0];
      if (approval) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(approval?.kind, 'api-register');
    await value.controller.resolveApproval({ id: approval.id, approved: true });
    assert.equal((await pending).status, 'key_required');
    return { reply: '설정에서 키를 입력해 주세요.' };
  });
  await value.controller.chat({ message: '날씨 API 등록해줘', context, history: [] });
}
test('approved chat API registration reaches settings, stores keys privately and removes the entry', async t => {
  const value = await setup(t), secret = TEST_API_KEY;
  assert.deepEqual(await value.controller.apisList(), { apis: [] });
  await assert.rejects(value.controller.callCad('manage_apis', { action: 'list' }), /진행/);
  await register(value);
  const pendingRequest = (await value.controller.status()).credentialRequest;
  assert.match(pendingRequest.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...pendingRequest, id: undefined }, { id: undefined, provider: 'api', apiId: 'weather', name: '날씨 API', issuanceUrl: 'https://example.org/keys' });
  assert.equal((await value.controller.apisList()).apis[0].configured, false);
  const result = await value.controller.apisSave({ id: 'weather', apiKey: secret });
  assert.equal(result.api.status, 'key_saved'); assert.equal(result.api.adapterReady, false);
  assert.equal(value.saved().keys.weather, secret);
  assert.equal((await value.controller.status()).credentialRequest, undefined);
  for (const publicValue of [result, await value.controller.apisList(), await value.controller.status(), await readFile(join(value.dataDir, 'api-connections.json'), 'utf8')]) assert.equal(JSON.stringify(publicValue).includes(secret), false);
  assert.deepEqual(await value.controller.apisRemove({ id: 'weather' }), { removed: true, id: 'weather' });
  assert.deepEqual(value.saved().keys, {}); assert.deepEqual(await value.controller.apisList(), { apis: [] });
});
test('built-in API credential requests keep their provider and settings entry without creating a generic adapter', async t => {
  const value = await setup(t);
  for (const id of ['vworld', 'kcsc']) {
    value.run(async () => {
      assert.deepEqual(await value.controller.callCad('manage_apis', { action: 'list' }), { apis: [] });
      const result = await value.controller.callCad('manage_apis', { action: 'request', id });
      assert.equal(result.settingsTarget, 'api');
      return { reply: result.message };
    });
    await value.controller.chat({ message: `${id} 키 등록 방법`, context, history: [] });
    const request = (await value.controller.status()).credentialRequest;
    assert.equal(request.provider, id); assert.equal(request.apiId, id); assert.ok(request.name);
  }
  assert.deepEqual(await value.controller.apisList(), { apis: [] });
});
test('chat deletion rejects extra input and active or closed operations, preserving other histories', async t => {
  const value = await setup(t), { controller } = value;
  const first = (await controller.chatCreate()).chat, second = (await controller.chatCreate()).chat;
  for (const input of [null, [], {}, { id: first.id, path: '/tmp/foreign' }, { id: '../foreign' }]) await assert.rejects(controller.chatDelete(input));
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  value.run(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { reply: '완료' }; });
  const turn = controller.chat({ chatId: first.id, message: '작업', context, history: [] });
  await ready;
  try {
    await assert.rejects(controller.chatDelete({ id: first.id }), /작업/);
    await assert.rejects(controller.apisSave({ id: 'weather', apiKey: TEST_API_KEY }), /작업/);
    await assert.rejects(controller.apisRemove({ id: 'weather' }), /작업/);
  } finally { release(); await turn; }
  assert.deepEqual(await controller.chatDelete({ id: first.id }), { id: first.id, deleted: true });
  assert.deepEqual((await controller.chatList()).chats.map(chat => chat.id), [second.id]);
  await assert.rejects(controller.chatRead(first.id));
  await controller.close();
  await assert.rejects(controller.chatDelete({ id: second.id }), /작업/);
  await assert.rejects(controller.apisSave({ id: 'weather', apiKey: TEST_API_KEY }), /작업/);
  await assert.rejects(controller.apisRemove({ id: 'weather' }), /작업/);
});
test('API key saving fails closed when no secure API store was provided', async t => {
  const value = await setup(t, { secure: false });
  await register(value);
  await assert.rejects(value.controller.apisSave({ id: 'weather', apiKey: TEST_API_KEY }), /저장/);
  assert.equal((await value.controller.apisList()).apis[0].configured, false);
});
