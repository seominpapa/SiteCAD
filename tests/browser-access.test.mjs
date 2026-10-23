import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAccess } from '../lib/browser-access.mjs';
import { createApp } from '../server.mjs';
import { startLocalPage } from '../public/browser-start.js';

async function setup(t, options = {}) {
  const access = createBrowserAccess(options);
  const desktop = { status: async () => ({ desktop: true, oauth: { connected: false } }), authorizeMcp: value => value === 'Bearer private', callCad: async () => ({ connected: true }) };
  const server = createApp({ desktop, browserAccess: access });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launchUrl = access.launchUrl(base);
  const launch = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie')?.split(';')[0];
  return { access, base, launchUrl, launch, cookie, request: (path, init = {}) => fetch(base + path, { ...init, headers: { Cookie: cookie, ...init.headers } }) };
}

test('browser launch exchanges a one-use capability for an HttpOnly session and removes it from the URL', async t => {
  const s = await setup(t);
  assert.equal(s.launch.status, 303);
  assert.equal(s.launch.headers.get('location'), '/');
  assert.match(s.launch.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(s.launch.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(s.launchUrl, { redirect: 'manual' })).status, 403);
  assert.equal((await s.request('/')).status, 200);
  assert.equal((await (await s.request('/api/health')).json()).data.browser, true);
});

test('all browser pages and API state require the launch session; MCP retains its separate private token', async t => {
  const s = await setup(t);
  for (const path of ['/', '/app/', '/api/health', '/api/desktop/status']) {
    assert.equal((await fetch(s.base + path)).status, 403);
    assert.equal((await s.request(path, { headers: { Cookie: 'wrong=secret' } })).status, 403);
  }
  assert.equal((await s.request('/api/desktop/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' }, body: JSON.stringify({ method: 'context' }) };
  assert.equal((await fetch(s.base + '/api/internal/mcp', init)).status, 200);
  assert.equal((await fetch(s.base + '/api/internal/mcp', { ...init, headers: { 'Content-Type': 'application/json' } })).status, 403);
});

test('expired bootstrap capability cannot establish a new session', async t => {
  let time = 0;
  const s = await setup(t, { now: () => time });
  const other = createBrowserAccess({ now: () => time });
  const expiredUrl = other.launchUrl(s.base);
  time = 300001;
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; }, writeHead: status => { headers.status = status; }, end() {} };
  assert.equal(other.protect({ method: 'GET', url: new URL(expiredUrl).pathname + new URL(expiredUrl).search, headers: {} }, res, '/launch'), false);
  assert.equal(headers.status, 403);
});

test('browser-only folder and exit actions require the authenticated local origin and JSON', async t => {
  const calls = [];
  const access = createBrowserAccess();
  const server = createApp({ browserAccess: access, browserActions: { openDrawings: async () => calls.push('folder'), quit: async () => calls.push('quit') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = await fetch(access.launchUrl(base), { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  for (const action of ['open-drawings', 'quit']) {
    for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: base, 'Content-Type': 'text/plain' }]) {
      assert.ok((await fetch(`${base}/api/local/${action}`, { method: 'POST', headers: { Cookie: cookie, ...headers }, body: '{}' })).status >= 400);
    }
    assert.equal((await fetch(`${base}/api/local/${action}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  }
  assert.deepEqual(calls, ['folder', 'quit']);
});

test('only one browser tab starts the CAD bridge and the desktop path remains unchanged', async () => {
  let started = 0; const blocked = [];
  await startLocalPage({ browserMode: false, start: async () => { started++; } });
  assert.equal(started, 1);
  await startLocalPage({ browserMode: true, locks: { request: async (_name, options, fn) => { assert.equal(options.ifAvailable, true); return fn(null); } }, start: async () => { started++; }, blocked: text => blocked.push(text) });
  assert.equal(started, 1); assert.match(blocked[0], /다른 탭/);
  await startLocalPage({ browserMode: true, start: async () => { started++; }, blocked: text => blocked.push(text) });
  assert.equal(started, 1); assert.match(blocked[1], /브라우저/);
  let callback;
  await startLocalPage({ browserMode: true, locks: { request: async (_name, _options, fn) => { callback = fn; } }, start: async () => { started++; }, blocked: text => blocked.push(text) });
  void callback({ name: 'owner' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
});

test('HTTP waits longer than the ten minute Codex turn budget so an active turn cannot outlive its chat response', () => {
  const server = createApp({ desktop: {} });
  assert.ok(server.timeout > 600000);
  assert.ok(server.requestTimeout > 600000);
});

 test('repeat activation issues a fresh one-use link while retaining the owner session', async t => {
  const s = await setup(t);
  const next = s.access.launchUrl(s.base);
  assert.equal((await fetch(next, { redirect: 'manual' })).status, 403);
  const response = await fetch(next, { redirect: 'manual', headers: { Cookie: s.cookie } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('set-cookie').split(';')[0], s.cookie);
  assert.equal((await fetch(next, { redirect: 'manual' })).status, 403);
});
