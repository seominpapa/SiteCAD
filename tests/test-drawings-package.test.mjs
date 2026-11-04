import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyTestDrawings, testDrawingNames } from '../scripts/package-drawings.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-test-drawings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), destination = join(directory, 'release');
  await mkdir(join(source, 'drawings/Test'), { recursive: true });
  for (const name of testDrawingNames) await writeFile(join(source, 'drawings/Test', name), `fixture ${name}`);
  return { directory, source, destination };
}

test('packaging copies exactly the curated seven DWGs and guide, excluding private drawings', async t => {
  const { source, destination } = await fixture(t);
  assert.equal(testDrawingNames.filter(name => name.endsWith('.dwg')).length, 7);
  assert.equal(testDrawingNames.filter(name => name.endsWith('.md')).length, 1);
  await writeFile(join(source, 'drawings/private.dwg'), 'private');
  await writeFile(join(source, 'drawings/Test/private.enc'), 'private');
  await copyTestDrawings(source, destination);
  assert.deepEqual((await readdir(join(destination, 'drawings/Test'))).sort(), [...testDrawingNames].sort());
  assert.deepEqual(await readdir(join(destination, 'drawings')), ['Test']);
  for (const name of testDrawingNames) assert.equal(await readFile(join(destination, 'drawings/Test', name), 'utf8'), `fixture ${name}`);
  await assert.rejects(copyTestDrawings(source, destination), { code: 'EEXIST' });
});

test('packaging rejects symlinked sample directories and files instead of including their targets', async t => {
  const { directory, source, destination } = await fixture(t);
  const outside = join(directory, 'private');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'private');
  await rm(join(source, 'drawings/Test'), { recursive: true });
  await symlink(outside, join(source, 'drawings/Test'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyTestDrawings(source, destination), /symbolic link/);
  await rm(join(source, 'drawings/Test'));
  await mkdir(join(source, 'drawings/Test'));
  const name = testDrawingNames[0];
  await symlink(outside, join(source, 'drawings/Test', name), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyTestDrawings(source, destination), /symbolic link/);
});

test('packaging requires regular sample files and fails on missing curated data', async t => {
  const { source, destination } = await fixture(t);
  const file = join(source, 'drawings/Test', testDrawingNames[0]);
  await rm(file);
  await assert.rejects(copyTestDrawings(source, destination), { code: 'ENOENT' });
  await mkdir(file);
  await assert.rejects(copyTestDrawings(source, destination), /regular file/);
  await rm(join(source, 'drawings/Test'), { recursive: true });
  await writeFile(join(source, 'drawings/Test'), 'not a directory');
  await assert.rejects(copyTestDrawings(source, destination), /must be a directory/);
});
