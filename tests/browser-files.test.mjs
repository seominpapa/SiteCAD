import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createBrowserAccess } from '../lib/browser-access.mjs';
import { createApp } from '../server.mjs';

const context = { documentId: 2, revision: 3, geometryRevision: 5, layout: 'Model', units: 4, selection: [], entities: [], command: null };
const bytes = Buffer.from('AC1032browser-download');
const result = { version: 'AC1032', dataBase64: bytes.toString('base64'), context: { ...context, revision: 4 }, audit: { errors: 0, droppedOnSave: 0 } };
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-browser-files-'));
  const controller = await createDesktopController({ dataDir, codexPath: '/app/codex', nodePath: '/app/node', secureStore: {},
    authFactory: async () => ({ status: async () => ({}), close: async () => {} }) });
  const access = createBrowserAccess();
  const server = createApp({ desktop: controller, browserAccess: access });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = await fetch(access.launchUrl(base), { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  const claim = await fetch(base+'/api/browser/claim',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({tabId:'browser-files-owner'})});
  const {data:{ownerToken}} = await claim.json();
  t.after(async () => { await controller.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { Cookie: cookie, Origin: base, 'X-SiteCAD-Owner':ownerToken, ...init.headers } });
  return { controller, dataDir, request, base };
}

test('manual browser save persists the audited bytes and downloads that exact file with its hash', async t => {
  const s = await setup(t);
  const response = await s.request('/api/local/drawings/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '한글 도면.dwg', result, expectedContext: context }) });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.name, '한글 도면.dwg');
  assert.equal(data.downloadUrl, `/api/local/drawings/${encodeURIComponent(data.name)}`);
  assert.equal(data.sha256, createHash('sha256').update(bytes).digest('hex'));
  const download = await s.request(data.downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8/);
  assert.equal(download.headers.get('x-content-sha256'), data.sha256);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), await readFile(data.path));
  assert.equal((await fetch(s.base + data.downloadUrl)).status, 403);
  assert.equal((await s.request('/api/local/drawings/missing.dwg')).status, 404);
});

test('manual browser save rejects changed geometry, pending commands, bad audit and unsafe filenames', async t => {
  const s = await setup(t);
  for (const changed of [{ context: { ...context, geometryRevision: 6 } }, { context: { ...context, command: { name: 'LINE' } } }, { audit: { errors: 1, droppedOnSave: 0 } }]) {
    await assert.rejects(s.controller.saveDrawing({ ...result, ...changed }, 'test.dwg', context));
  }
  await assert.rejects(s.controller.saveDrawing(result, '../bad.dwg', context));
  await writeFile(join(s.dataDir, 'outside.dwg'), bytes);
  await symlink(join(s.dataDir, 'outside.dwg'), join(s.dataDir, 'Drawings', 'linked.dwg'));
  await assert.rejects(s.controller.readDrawing('linked.dwg'));
  assert.equal((await s.request('/api/local/drawings/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: '{}' })).status, 403);
});

test('terrain browser upload accepts multipart files only behind the session and exact local origin', async t => {
  const s = await setup(t);
  let received;
  s.controller.terrainImport = async files => { received = files; return { dataset: { id: 'test' } }; };
  const body = new FormData(); body.append('files', new Blob(['{}']), 'terrain.geojson');
  const response = await s.request('/api/local/terrain/import', { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.equal(received[0].name, 'terrain.geojson');
  assert.deepEqual(received[0].bytes, Buffer.from('{}'));
  assert.equal((await s.request('/api/local/terrain/import', { method: 'POST', headers: { Origin: 'https://evil.test' }, body })).status, 403);
  const invalid = new FormData(); invalid.append('path', '/etc/passwd');
  assert.equal((await s.request('/api/local/terrain/import', { method: 'POST', body: invalid })).status, 400);
});
