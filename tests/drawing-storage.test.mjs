import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDrawingStorage } from '../lib/drawing-storage.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sitecad-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'private'), defaultPath = join(root, 'installed app');
  await mkdir(dataDir); await mkdir(defaultPath);
  return { root, dataDir, defaultPath, storage: await createDrawingStorage({ dataDir, defaultPath }) };
}

test('defaults to installation root, persists chosen folder, and resets without moving existing files', async t => {
  const { root, dataDir, defaultPath, storage } = await setup(t);
  assert.deepEqual(storage.status(), { path: defaultPath, defaultPath, isDefault: true });
  await writeFile(join(defaultPath, 'original.dwg'), 'AC1032original');
  const chosen = join(root, '사용자 도면'); await mkdir(chosen);
  const priorMode = (await lstat(chosen)).mode;
  assert.equal((await storage.save({ path: chosen })).path, chosen);
  assert.equal(await storage.directory(), chosen);
  assert.equal((await lstat(chosen)).mode, priorMode);
  assert.deepEqual(await readdir(chosen), []);
  const restarted = await createDrawingStorage({ dataDir, defaultPath });
  assert.deepEqual(restarted.status(), { path: chosen, defaultPath, isDefault: false });
  assert.equal((await restarted.save({ path: '' })).isDefault, true);
  assert.equal(await readFile(join(defaultPath, 'original.dwg'), 'utf8'), 'AC1032original');
  if (process.platform !== 'win32') assert.equal((await lstat(join(dataDir, 'drawing-storage.json'))).mode & 0o777, 0o600);
});

test('rejects malformed or unavailable folders without changing current setting', async t => {
  const { root, storage, defaultPath } = await setup(t);
  const file = join(root, 'not-folder'); await writeFile(file, 'x');
  for (const input of [null, [], {}, { path: 4 }, { path: 'relative' }, { path: '\0bad' }, { path: '/x\ny' }, { path: '/'.repeat(4097) }, { path: file }, { path: join(root, 'missing') }, { path: defaultPath, extra: true }]) {
    await assert.rejects(storage.save(input));
    assert.equal(storage.status().path, defaultPath);
  }
});

test('removed selected folder never silently falls back to installation folder', async t => {
  const { root, dataDir, storage, defaultPath } = await setup(t);
  const chosen = join(root, 'removed'); await mkdir(chosen);
  await storage.save({ path: chosen }); await rm(chosen, { recursive: true });
  const restarted = await createDrawingStorage({ dataDir, defaultPath });
  assert.equal(restarted.status().path, chosen);
  await assert.rejects(restarted.directory(), /폴더/);
});

test('unwritable folder is rejected without replacing the selected location', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { root, storage, defaultPath } = await setup(t);
  const chosen = join(root, 'read-only'); await mkdir(chosen); await chmod(chosen, 0o500);
  try {
    await assert.rejects(storage.save({ path: chosen }));
    assert.equal(storage.status().path, defaultPath);
  } finally { await chmod(chosen, 0o700); }
});

test('corrupt or symlink preferences fail closed and a failed commit retains old folder', async t => {
  const { root, dataDir, defaultPath, storage } = await setup(t);
  const file = join(dataDir, 'drawing-storage.json'), chosen = join(root, 'chosen'); await mkdir(chosen);
  await mkdir(file);
  await assert.rejects(storage.save({ path: chosen }));
  assert.equal(storage.status().path, defaultPath);
  assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  await rm(file, { recursive: true }); await writeFile(file, '{broken');
  await assert.rejects(createDrawingStorage({ dataDir, defaultPath }));
  await rm(file); await writeFile(join(root, 'outside'), JSON.stringify({ version: 1, path: chosen }));
  if (process.platform !== 'win32') {
    await symlink(join(root, 'outside'), file);
    await assert.rejects(createDrawingStorage({ dataDir, defaultPath }));
  }
});

test('default drawings is created lazily, reset uses it, and explicitly selected folders remain unchanged', async t => {
  const { root, dataDir } = await setup(t), defaultPath = join(root, 'downloaded webapp', 'drawings');
  const storage = await createDrawingStorage({ dataDir, defaultPath });
  assert.equal(storage.status().path, defaultPath);
  await assert.rejects(lstat(defaultPath), { code: 'ENOENT' });
  assert.equal(await storage.directory(), defaultPath);
  assert.equal((await lstat(defaultPath)).isDirectory(), true);
  await storage.save({ path: root + '/' });
  const reopened = await createDrawingStorage({ dataDir, defaultPath });
  assert.equal(reopened.status().path, root);
  assert.equal((await reopened.save({ path: '' })).path, defaultPath);
});
