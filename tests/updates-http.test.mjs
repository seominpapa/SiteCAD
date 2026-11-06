import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, input, headers = {}) => fetch(base + path, input === undefined ? {} : {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
}

test('manual updates need local owner, exact consent and an idle application', async t => {
  let owned = true, active = false, busy = false;
  const calls = [];
  const status = { supported: true, kind: 'desktop', currentVersion: '0.16.3', status: 'available', availableVersion: '0.16.4' };
  const request = await fixture(t, { desktop: { status: async () => ({ active, busy }) }, updates: {
    status: () => status,
    check: async () => { calls.push('check'); return status; },
    install: async () => { calls.push('install'); return { ...status, status: 'scheduled' }; },
  }, browserAccess: { protect: async () => true, assertOwner() { if (!owned) throw Object.assign(Error('Owner required'), { status: 403 }); } } });
  assert.deepEqual((await (await request('/api/desktop/updates')).json()).data, status);
  const check = '/api/desktop/updates/check', install = '/api/desktop/updates/install';
  assert.equal((await request(check, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(check, {}, { 'Content-Type': 'text/plain' })).status, 415);
  owned = false;
  assert.equal((await request(install, { approved: true })).status, 403);
  owned = true;
  for (const invalid of [{}, { approved: false }, { approved: true, version: '9.0.0' }, null, []]) assert.equal((await request(install, invalid)).status, 400);
  assert.equal((await request(check, { version: '9.0.0' })).status, 400);
  assert.deepEqual(calls, []);
  active = true;
  assert.equal((await request(install, { approved: true })).status, 409);
  active = false;
  busy = true;
  assert.equal((await request(install, { approved: true })).status, 409);
  busy = false;
  assert.equal((await request(check, {})).status, 200);
  assert.equal((await (await request(install, { approved: true })).json()).data.status, 'scheduled');
  assert.deepEqual(calls, ['check', 'install']);
});

test('installation holds the chat gate while application state is checked', async t => {
  let release, entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const request = await fixture(t, { desktop: { status: async () => {
    entered(); return new Promise(resolve => { release = () => resolve({ active: false }); });
  } }, updates: {
    status: () => ({ supported: true, status: 'available' }),
    install: async () => ({ supported: true, status: 'scheduled' }),
  } });
  const install = request('/api/desktop/updates/install', { approved: true });
  await checking;
  try {
    assert.equal((await request('/api/chat', { message: '도면 확인해줘', history: [], context: { documentId: 2, revision: 1, units: 4, selection: [], entities: [] } })).status, 409);
    assert.equal((await request('/api/desktop/updates/install', { approved: true })).status, 409);
  } finally { release(); }
  assert.equal((await install).status, 200);
});

test('unmanaged development servers report update unavailability and reject installation', async t => {
  const request = await fixture(t, { desktop: { status: async () => ({ active: false }) } });
  assert.equal((await (await request('/api/desktop/updates')).json()).data.supported, false);
  assert.equal((await request('/api/desktop/updates/install', { approved: true })).status, 409);
});
