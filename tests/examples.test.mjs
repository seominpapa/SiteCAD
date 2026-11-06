import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function setup(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, request: (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: base, ...init.headers } }) };
}

test('examples list names and descriptions for all curated drawings, and selected bytes open through SiteCAD', async t => {
  const s = await setup(t);
  const response = await s.request('/api/examples');
  assert.equal(response.status, 200);
  const { data: { examples } } = await response.json();
  assert.equal(examples.length, 7);
  assert.equal(examples.filter(item => item.name.includes('옹벽')).length, 3);
  assert.equal(examples.filter(item => item.name.includes('통로박스')).length, 4);
  for (const example of examples) {
    assert.ok(example.description);
    assert.equal(example.url, `/api/examples/${example.file}`);
    const drawing = await s.request(example.url);
    assert.equal(drawing.status, 200);
    assert.match(drawing.headers.get('content-type'), /application\/acad/);
    assert.equal(drawing.headers.get('content-disposition'), null);
    assert.deepEqual(Buffer.from(await drawing.arrayBuffer()), await readFile(new URL(`../drawings/Test/${example.file}`, import.meta.url)));
  }
});

test('example downloads expose only allowlisted bundled files and reject paths and outside links', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const examplesRoot = join(directory, 'samples'); await mkdir(examplesRoot);
  await writeFile(join(directory, 'private.dwg'), 'AC1032private');
  await symlink(join(directory, 'private.dwg'), join(examplesRoot, 'retaining-wall-3m-normal.dwg'));
  const s = await setup(t, { examplesRoot });
  for (const path of ['/api/examples/private.dwg', '/api/examples/테스트_안내.md', '/api/examples/%2e%2e%2fprivate.dwg', '/api/examples/retaining-wall-3m-normal.dwg']) {
    assert.equal((await s.request(path)).status, 404, path);
  }
  assert.equal((await s.request('/api/examples', { method: 'POST', body: '{}' })).status, 405);
});

test('desktop header folder and quit use exact-origin JSON without permitting arbitrary arguments', async t => {
  const calls = [];
  const s = await setup(t, { desktop: {}, browserActions: { openDrawings: async () => calls.push('folder'), quit: async () => calls.push('quit') } });
  for (const action of ['open-drawings', 'quit']) {
    const path = `/api/desktop/local/${action}`;
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    assert.equal((await s.request(path, { ...request, headers: { ...request.headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await s.request(path, { ...request, headers: { ...request.headers, 'Content-Type': 'text/plain' } })).status, 415);
    for (const body of ['null', '[]', '{"path":"/private"}']) assert.equal((await s.request(path, { ...request, body })).status, 400);
    assert.equal((await s.request(path, request)).status, 200);
  }
  assert.deepEqual(calls, ['folder', 'quit']);
});
