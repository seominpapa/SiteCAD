import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiConnections, checkedApiRegistration, apiCredentialRequest } from '../lib/api-connections.mjs';

const TEST_API_KEY = 'test-only-secret';
const TEST_KEY_WITH_SPACE = 'secret with space';
const TEST_STORE_KEY = 'test-only-key';

const registration = { id: 'weather', name: '날씨 API', url: 'https://example.org/docs', issuanceUrl: 'https://example.org/account/keys' };
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-apis-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let value;
  const store = { read: async () => structuredClone(value), write: async input => { value = structuredClone(input); }, clear: async () => { value = undefined; } };
  const manager = await createApiConnections({ dataDir, store });
  return { dataDir, store, manager, secret: () => value };
}

test('chat registration persists metadata only, and settings store keys without claiming an adapter', async t => {
  const { dataDir, store, manager, secret } = await fixture(t);
  assert.deepEqual(await manager.list(), { apis: [] });
  const result = await manager.register(registration);
  assert.equal(result.status, 'key_required');
  assert.equal(result.apiId, 'weather');
  assert.equal(result.settingsTarget, 'api');
  assert.equal(result.issuanceUrl, registration.issuanceUrl);
  const fakeKey = 'test-only-api-secret';
  const saved = await manager.save({ id: 'weather', apiKey: fakeKey });
  assert.equal(saved.api.configured, true);
  assert.equal(saved.api.status, 'key_saved');
  assert.equal(saved.api.adapterReady, false);
  assert.match(saved.api.message, /실행 연결.*구성되지/);
  assert.equal(secret().keys.weather, fakeKey);
  assert.doesNotMatch(JSON.stringify(await manager.list()), /test-only-api-secret/);
  assert.doesNotMatch(await readFile(join(dataDir, 'api-connections.json'), 'utf8'), /test-only-api-secret|apiKey/);
  if (process.platform !== 'win32') assert.equal((await stat(join(dataDir, 'api-connections.json'))).mode & 0o777, 0o600);
  const reopened = await createApiConnections({ dataDir, store });
  assert.equal((await reopened.list()).apis[0].configured, true);
  assert.equal((await reopened.register(registration)).status, 'key_saved');
  await assert.rejects(reopened.register({ ...registration, url: 'https://example.org/other' }), /이미/);
  assert.deepEqual(await reopened.remove({ id: 'weather' }), { removed: true, id: 'weather' });
  assert.deepEqual(await reopened.list(), { apis: [] });
  assert.equal(secret()?.keys?.weather, undefined);
});

test('registration rejects secrets, private addresses, mismatched issuance sites and reserved identities', () => {
  for (const url of ['http://example.org/', 'https://user:password@example.org/', 'https://example.org/?api_key=secret', 'https://example.org/#secret', 'https://127.0.0.1/', 'https://[::1]/', 'https://10.1.1.1/', 'https://localhost/', 'https://service.local/', 'https://service.internal/', 'https://example.org:8443/']) {
    assert.throws(() => checkedApiRegistration({ ...registration, url }));
  }
  for (const input of [{ ...registration, issuanceUrl: 'https://example.org.evil.com/keys' }, { ...registration, apiKey: 'secret' }, { ...registration, id: '__proto__' }, { ...registration, id: 'kcsc' }, { ...registration, name: 'name\nspoof' }]) assert.throws(() => checkedApiRegistration(input));
  assert.equal(checkedApiRegistration({ ...registration, issuanceUrl: 'https://www.example.org/keys' }).id, 'weather');
});

test('unregistered keys, malformed requests and unavailable secret stores fail closed', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.save({ id: 'weather', apiKey: TEST_API_KEY }), /등록/);
  await manager.register(registration);
  for (const input of [{ id: 'weather', apiKey: 'x' }, { id: 'weather', apiKey: TEST_KEY_WITH_SPACE }, { id: 'weather', apiKey: TEST_API_KEY, token: 'x' }]) await assert.rejects(manager.save(input));
  await assert.rejects(manager.remove({ id: '../weather' }));
});

test('metadata corruption or symlink is never overwritten and concurrent registration preserves each item', async t => {
  const { manager, dataDir, store } = await fixture(t);
  await Promise.all([manager.register(registration), manager.register({ ...registration, id: 'map', name: '지도 API' })]);
  assert.equal((await manager.list()).apis.length, 2);
  const path = join(dataDir, 'api-connections.json');
  await writeFile(path, '{invalid');
  await assert.rejects(manager.list(), /등록 정보/);
  await assert.rejects(manager.register({ ...registration, id: 'another' }), /등록 정보/);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
  await rm(path);
  const target = join(dataDir, 'outside.json');
  await writeFile(target, '{"version":1,"apis":[]}');
  await symlink(target, path);
  await assert.rejects(createApiConnections({ dataDir, store }), /등록 정보/);
});

test('built-in credential guidance points at private settings, never asks for a key through a tool', () => {
  for (const id of ['vworld', 'kcsc']) {
    const request = apiCredentialRequest(id);
    assert.equal(request.status, 'key_required');
    assert.equal(request.settingsTarget, 'api');
    assert.equal(request.apiId, id);
    assert.match(request.issuanceUrl, /^https:/);
    assert.match(request.message, /설정/);
  }
  assert.throws(() => apiCredentialRequest('unknown'));
});

test('secret store errors stay private and failed writes never report a configured key', async t => {
  const { dataDir, manager } = await fixture(t);
  await manager.register(registration);
  const unavailable = await createApiConnections({ dataDir });
  await assert.rejects(unavailable.save({ id: 'weather', apiKey: TEST_STORE_KEY }), /비공개 저장소/);
  const broken = await createApiConnections({ dataDir, store: { read: async () => { throw Error('private-secret'); } } });
  await assert.rejects(broken.list(), error => !error.message.includes('private-secret'));
  const failed = await createApiConnections({ dataDir, store: { read: async () => null, write: async () => { throw Error('private-secret'); } } });
  await assert.rejects(failed.save({ id: 'weather', apiKey: TEST_STORE_KEY }), error => !error.message.includes('private-secret'));
  assert.equal((await failed.list()).apis[0].configured, false);
});
