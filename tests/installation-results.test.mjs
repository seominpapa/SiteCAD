import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallationResults } from '../lib/installation-results.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-install-results-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createInstallationResults({ dataDir }), file: join(dataDir, 'installation-results.json') };
}
test('installation history persists public outcomes and replaces private error messages', async t => {
  const { dataDir, store, file } = await setup(t);
  assert.deepEqual(await store.list('mcp'), []);
  const first = await store.record({ kind: 'mcp', name: 'remote', status: 'failed', message: 'API_KEY=private-secret /Users/private/path' });
  await store.record({ kind: 'plugin', name: 'cad-tools', status: 'installed' });
  await store.record({ kind: 'mcp', name: 'remote', status: 'key_required' });
  const restarted = createInstallationResults({ dataDir });
  const mcp = await restarted.list('mcp');
  assert.equal(mcp.length, 2); assert.equal(mcp[0].status, 'key_required'); assert.equal(mcp[1].id, first.id);
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'kind', 'message', 'name', 'status']);
  assert.match(first.id, /^[a-f0-9-]{36}$/); assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.equal((await restarted.list('plugin'))[0].name, 'cad-tools');
  assert.doesNotMatch(await readFile(file, 'utf8'), /private-secret|Users\/private/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('concurrent recording retains only the newest thirty outcomes in insertion order', async t => {
  const { store } = await setup(t);
  await Promise.all(Array.from({ length: 35 }, (_, index) => store.record({ kind: 'mcp', name: `remote-${index}`, status: 'connected' })));
  const results = await store.list('mcp');
  assert.equal(results.length, 30); assert.equal(results[0].name, 'remote-34'); assert.equal(results.at(-1).name, 'remote-5');
  assert.equal(new Set(results.map(item => item.id)).size, 30);
  results[0].name = 'changed';
  assert.equal((await store.list('mcp'))[0].name, 'remote-34');
});
test('invalid outcomes and corrupted history are rejected without overwriting existing records', async t => {
  const { store, file } = await setup(t);
  await store.record({ kind: 'mcp', name: 'remote', status: 'failed' });
  const before = await readFile(file, 'utf8');
  for (const value of [null, {}, { kind: 'api', name: 'remote', status: 'installed' }, { kind: 'plugin', name: 'remote', status: 'connected' }, { kind: 'mcp', name: '../escape', status: 'failed' }, { kind: 'mcp', name: 'remote', status: 'failed', args: ['private'] }]) await assert.rejects(store.record(value));
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(store.list('other'));
  await writeFile(file, '{corrupt');
  await assert.rejects(store.list('mcp'), /설치 기록/);
  await assert.rejects(store.record({ kind: 'mcp', name: 'remote', status: 'connected' }), /설치 기록/);
  assert.equal(await readFile(file, 'utf8'), '{corrupt');
});
test('history never follows a substituted symbolic link', async t => {
  const { store, file, dataDir } = await setup(t);
  const target = join(dataDir, 'unrelated.json');
  await writeFile(target, 'private unrelated file'); await symlink(target, file);
  await assert.rejects(store.list('mcp'), /설치 기록/);
  await assert.rejects(store.record({ kind: 'mcp', name: 'remote', status: 'connected' }), /설치 기록/);
  assert.equal(await readFile(target, 'utf8'), 'private unrelated file');
});
