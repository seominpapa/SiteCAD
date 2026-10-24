import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createApp } from '../server.mjs';

const PRIVATE_KEY = 'fixture-private-kcsc-key';
const safeStatus = { configured: true, installed: true, connected: true, tools: ['kcsc_search'], count: 1 };

async function fixture(t, { save } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-kcsc-controller-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const controller = await createDesktopController({ dataDir, nodePath: process.execPath,
    authFactory: async () => ({ status: async () => ({ loggedIn: true }), cancel: async () => {}, close: async () => {} }),
    kcscFactory: ({ registry }) => {
      assert.equal(typeof registry.revision, 'function');
      return { status: async () => structuredClone(safeStatus),
        save: async (input, options) => { calls.push('save'); return save ? save(input, options) : structuredClone(safeStatus); },
        test: async input => { calls.push('test'); assert.deepEqual(input, {}); return structuredClone(safeStatus); },
        remove: async input => { calls.push('remove'); assert.deepEqual(input, {}); return { ...safeStatus, configured: false, connected: false }; } };
    } });
  t.after(() => controller.close());
  return { controller, calls };
}

test('controller exposes safe KCSC status and serializes changes with all existing CAD connection guards', async t => {
  let release;
  const f = await fixture(t, { save: () => new Promise(resolve => { release = () => resolve(safeStatus); }) });
  assert.deepEqual((await f.controller.status()).kcsc, safeStatus);
  assert.deepEqual(await f.controller.kcscStatus(), safeStatus);
  const pending = f.controller.kcscSave({ apiKey: PRIVATE_KEY, trusted: true });
  await assert.rejects(f.controller.kcscTest({}), /작업/);
  await assert.rejects(f.controller.kcscRemove({}), /작업/);
  await assert.rejects(f.controller.mcpSave({ trusted: true, config: {} }), /진행|끝/);
  await assert.rejects(f.controller.chat({ message: '선 그려줘', history: [], context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] } }), /설정|작업/);
  release(); await pending;
  assert.equal((await f.controller.kcscTest({})).connected, true);
  assert.equal((await f.controller.kcscRemove({})).configured, false);
  assert.deepEqual(f.calls, ['save', 'test', 'remove']);
});

test('controller stop cancels a pending KCSC installation and permits later requests', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { save: (_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('취소')), { once: true }); began();
  }) });
  const pending = f.controller.kcscSave({ apiKey: PRIVATE_KEY, trusted: true });
  const rejected = assert.rejects(pending, /취소/);
  await started; await f.controller.cancel(); await rejected;
  assert.equal((await f.controller.kcscTest({})).connected, true);
});

test('KCSC HTTP endpoints preserve browser ownership, same-origin and JSON requirements', async t => {
  const f = await fixture(t);
  let owner = true;
  const app = createApp({ desktop: f.controller, browserAccess: {
    protect: async () => true,
    assertOwner: () => { if (!owner) throw Object.assign(Error('읽기 전용'), { status: 409 }); },
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (action, body = {}, headers = {}) => fetch(`${base}/api/desktop/kcsc/${action}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.deepEqual((await (await fetch(`${base}/api/desktop/kcsc`)).json()).data, safeStatus);
  for (const action of ['save', 'test', 'remove']) {
    assert.equal((await request(action, {}, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await request(action, {}, { 'Content-Type': 'text/plain' })).status, 415);
    owner = false;
    assert.notEqual((await request(action)).status, 200);
    owner = true;
    assert.equal((await request(action, action === 'save' ? { apiKey: PRIVATE_KEY, trusted: true } : {})).status, 200);
  }
  assert.deepEqual(f.calls, ['save', 'test', 'remove']);
});
