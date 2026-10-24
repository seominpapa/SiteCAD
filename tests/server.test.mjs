import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp, cadFont } from '../server.mjs';

const payload = { message: '사각형', context: { documentId: 2, revision: 0, units: 4, selection: [], entities: [] }, history: [] };
async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cad-http-test-'));
  await mkdir(join(root, 'public')); await mkdir(join(root, 'editor'));
  await writeFile(join(root, 'public', 'index.html'), 'chat');
  await writeFile(join(root, 'editor', 'index.html'), 'editor');
  await writeFile(join(root, 'editor', 'engine.wasm'), new Uint8Array([0, 97, 115, 109]));
  await symlink('/etc/hosts', join(root, 'public', 'leak.txt'));
  const app = createApp({ publicRoot: join(root, 'public'), editorRoot: join(root, 'editor'), authStatus: async () => ({ connected: true, method: 'chatgpt' }), plan: async () => ({ reply: '완료', operations: [{ type: 'undo' }] }), ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { ...(init.method === 'POST' ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...init.headers } });
  return { app, request, base, close: async () => { await new Promise(resolve => app.close(resolve)); await rm(root, { recursive: true, force: true }); } };
}
test('serves local chat, editor/wasm and bounded structured plans', async () => {
  const t = await setup();
  try {
    assert.equal(await (await t.request('/')).text(), 'chat');
    assert.equal(await (await t.request('/app/')).text(), 'editor');
    assert.equal((await t.request('/app/engine.wasm')).headers.get('content-type'), 'application/wasm');
    assert.equal((await (await t.request('/api/health')).json()).data.oauth.connected, true);
    const response = await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.base, payload.context && { documentId: 2, revision: 0, units: 4, selection: [] });
    assert.equal((await t.request('/api/missing')).status, 404);
    assert.equal((await t.request('/leak.txt')).status, 404);
  } finally { await t.close(); }
});
test('standalone source serves its bundled example drawing without a parent checkout', async () => {
  const t = await setup();
  try {
    const response = await t.request('/fixtures/retaining-wall.dwg');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../fixtures/retaining-wall.dwg', import.meta.url)));
  } finally { await t.close(); }
});
test('rejects cross-origin, unexpected host, malformed and oversized chat requests', async () => {
  const t = await setup();
  try {
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) assert.equal((await t.request('/api/chat', { method: 'POST', headers, body: JSON.stringify(payload) })).status >= 400, true, JSON.stringify(headers));
    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(t.base, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await t.request('/api/chat', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await t.request('/api/chat', { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await t.request('/api/chat', { method: 'POST', body: 'x'.repeat(140000) })).status, 413);
  } finally { await t.close(); }
});
test('Korean CAD font paths select the actual operating system font', () => {
  assert.deepEqual(cadFont('darwin'), { name: 'AppleGothic.ttf', directory: '/System/Library/Fonts/Supplemental' });
  assert.deepEqual(cadFont('win32', 'D:\\Windows'), { name: 'malgun.ttf', directory: 'D:\\Windows\\Fonts' });
});
test('serves only the installed Korean CAD font through GET and HEAD', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const app = createApp();
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, init) => fetch(base + path, init);
  try {
    const font = cadFont();
    const expected = await readFile(join(font.directory, font.name));
    for (const path of ['/api/cad-font', '/api/cad-font?path=/etc/hosts&file=../../server.mjs']) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'font/ttf');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('X-SiteCAD-CAD-Font'), font.name);
      assert.equal(Number(response.headers.get('content-length')), expected.length);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    }
    const head = await request('/api/cad-font', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'font/ttf');
    assert.equal(head.headers.get('X-SiteCAD-CAD-Font'), font.name);
    assert.equal(Number(head.headers.get('content-length')), expected.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await request('/api/cad-font', { method: 'POST', body: '{}' })).status, 405);
    for (const path of ['/api/cad-font/AppleGothic.ttf', '/api/cad-font/%2e%2e%2fetc%2fhosts', '/api/cad-font.ttf']) assert.equal((await request(path)).status, 404);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
test('OAuth failures and planner failures do not expose private error text', async () => {
  for (const options of [{ authStatus: async () => ({ connected: false, method: 'chatgpt' }) }, { plan: async () => { throw Error('private-secret-value'); } }, { plan: async () => ({ reply: 'x', operations: [{ type: 'exec' }] }) }]) {
    const t = await setup(options);
    try { const r = await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) }); assert.ok(r.status >= 500); assert.doesNotMatch(await r.text(), /private-secret-value/); }
    finally { await t.close(); }
  }
});
test('allows only one planner operation at a time', async () => {
  let unblock; let started;
  const wait = new Promise(resolve => { started = resolve; });
  const t = await setup({ plan: async () => { started(); await new Promise(resolve => { unblock = resolve; }); return { reply: '완료', operations: [] }; } });
  try {
    const first = t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) });
    await wait;
    assert.equal((await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) })).status, 429);
    unblock(); assert.equal((await first).status, 200);
  } finally { unblock?.(); await t.close(); }
});
test('rate limit expires and OAuth cache refreshes without repeated login reads', async () => {
  let time = 1000; let reads = 0;
  const t = await setup({ now: () => time, authStatus: async () => { reads++; return { connected: true }; } });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) })).status, 200);
    assert.equal(reads, 1);
    assert.equal((await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) })).status, 429);
    time += 60001;
    assert.equal((await t.request('/api/chat', { method: 'POST', body: JSON.stringify(payload) })).status, 200);
    assert.equal(reads, 2);
  } finally { await t.close(); }
});
test('blocks geometry writes in drawings whose units are unknown', async () => {
  const t = await setup({ plan: async () => ({ reply: '그립니다', operations: [{ type: 'circle', x_mm: 0, y_mm: 0, radius_mm: 500 }] }) });
  try {
    const response = await t.request('/api/chat', { method: 'POST', body: JSON.stringify({ ...payload, context: { ...payload.context, units: 0 } }) });
    const result = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(result.data.operations, []); assert.match(result.data.reply, /단위/);
    assert.equal((await t.request('/lib/planner.mjs')).status, 404);
    assert.equal((await t.request('/.env')).status, 404);
    assert.equal((await t.request('/%2e%2e%2fserver.mjs')).status, 404);
    assert.equal((await t.request('/', { method: 'DELETE' })).status, 405);
  } finally { await t.close(); }
});

test('chat returns a quantity-review intent bound to the current drawing, never AI totals', async () => {
  const t = await setup({ plan: async () => ({ reply: '레이어별 물량을 검토합니다.', operations: [{ type: 'quantity_review' }] }) });
  try {
    const response = await t.request('/api/chat', { method: 'POST', body: JSON.stringify({ ...payload, message: '전체 도면 물량검토' }) });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.operations, [{ type: 'quantity_review' }]);
    assert.deepEqual(data.base, { documentId: 2, revision: 0, units: 4, selection: [] });
    assert.equal(data.totals, undefined);
  } finally { await t.close(); }
});

test('desktop runtime routes require local origin or a private MCP token and return executed results', async () => {
  const calls = [];
  const desktop = { status: async () => ({ desktop: true, oauth: { connected: true }, auth: { loggedIn: true } }),
    chat: async input => ({ reply: input.message, executed: true, details: ['실행 완료'] }),
    login: async () => ({ pending: true }), logout: async () => {}, cancel: async () => {},
    authorizeMcp: value => value === 'Bearer private-test',
    callCad: async (method, input) => { calls.push([method, input]); return { documentId: 2 }; },
    pollCad: async () => ({ id: 'job', method: 'context', payload: {} }),
    completeCad: (id, result) => { calls.push([id, result]); } };
  desktop.mcpList = async () => ({ servers: [{ name: 'rea' }] });
  desktop.referencesStatus = async () => ({ vworld: { configured: false }, catalog: [] });
  desktop.terrainStatus = async () => ({ datasets: [] });
  desktop.terrainImport = async () => ({ cancelled: true });
  for (const method of ['referencesSave', 'referencesRemove', 'referencesTest']) desktop[method] = async body => ({ action: method, ...(body ?? {}) });
  for (const method of ['mcpSave', 'mcpToggle', 'mcpRemove', 'mcpTest', 'resolveApproval']) desktop[method] = async body => ({ action: method, ...body });
  const t = await setup({ desktop });
  try {
    assert.equal((await (await t.request('/api/health')).json()).data.desktop, true);
    assert.equal((await (await t.request('/api/desktop/status')).json()).data.auth.loggedIn, true);
    const request = (path, body = {}, headers = {}) => t.request(path, { method: 'POST', body: JSON.stringify(body), headers });
    assert.equal((await request('/api/desktop/login', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await (await request('/api/desktop/login')).json()).data.pending, true);
    assert.equal((await (await request('/api/desktop/cad/poll')).json()).data.id, 'job');
    assert.equal((await request('/api/desktop/cad/result', { id: 'job', result: {} })).status, 200);
    assert.equal((await request('/api/internal/mcp', { method: 'context', payload: {} })).status, 403);
    assert.equal((await request('/api/internal/mcp', { method: 'context', payload: {} }, { Authorization: 'Bearer private-test' })).status, 200);
    assert.equal(calls.length, 2);
    assert.equal((await (await t.request('/api/desktop/mcp')).json()).data.servers[0].name, 'rea');
    assert.equal((await (await t.request('/api/desktop/references')).json()).data.vworld.configured, false);
    assert.deepEqual((await (await t.request('/api/desktop/terrain')).json()).data.datasets, []);
    assert.equal((await request('/api/desktop/terrain/import', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/desktop/terrain/import', { path: '/private/data.shp' })).status, 400);
    assert.equal((await (await request('/api/desktop/terrain/import')).json()).data.cancelled, true);
    for (const action of ['save', 'test', 'remove']) {
      assert.equal((await request(`/api/desktop/references/${action}`, {}, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await request(`/api/desktop/references/${action}`)).status, 200);
    }
    for (const action of ['save', 'toggle', 'remove', 'test']) {
      assert.equal((await request(`/api/desktop/mcp/${action}`, {}, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await (await request(`/api/desktop/mcp/${action}`, { name: 'rea' })).json()).data.name, 'rea');
    }
    assert.equal((await (await request('/api/desktop/approvals/resolve', { id: 'a', approved: true })).json()).data.approved, true);
    const result = await (await request('/api/chat', payload)).json();
    assert.equal(result.data.executed, true);
    assert.equal(result.data.reply, '사각형');
  } finally { await t.close(); }
});
