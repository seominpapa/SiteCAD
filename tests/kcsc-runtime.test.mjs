import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKcscInstaller, KCSC_PYTHON_VERSION, KCSC_VERSION } from '../lib/kcsc-runtime.mjs';

test('Intel Mac KCSC bootstrap rejects before network, process execution, or filesystem writes', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'SiteCAD KCSC unsupported '));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let fetched = false, executed = false;
  const installer = createKcscInstaller({ dataDir: join(parent, 'new install'), platform: 'darwin', arch: 'x64',
    fetchImpl: async () => { fetched = true; throw Error('Unexpected network access'); },
    execute: async () => { executed = true; throw Error('Unexpected process execution'); },
  });
  await assert.rejects(installer.install(), error => error.sitecadSafe === true &&
    /Intel Mac/.test(error.message) && /Apple Silicon/.test(error.message) && /Windows/.test(error.message));
  assert.equal(fetched, false);
  assert.equal(executed, false);
  assert.deepEqual(await readdir(parent), []);
});

test('a verified existing Intel Mac KCSC installation remains available without installing again', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'SiteCAD KCSC existing '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = join(dataDir, 'mcp-runtime', 'kcsc'), directory = '00000000-0000-4000-8000-000000000001';
  const command = join(root, directory, 'venv', 'bin', 'python');
  await mkdir(join(root, directory, 'venv', 'bin'), { recursive: true });
  await writeFile(command, 'existing isolated runtime');
  const lock = createHash('sha256').update(await readFile(new URL('../lib/kcsc-requirements.lock', import.meta.url))).digest('hex');
  await writeFile(join(root, 'installation.json'), JSON.stringify({ version: KCSC_VERSION, python: KCSC_PYTHON_VERSION,
    platform: 'darwin', arch: 'x64', lock, directory }));
  const installer = createKcscInstaller({ dataDir, platform: 'darwin', arch: 'x64',
    fetchImpl: async () => { throw Error('Unexpected network access'); },
    execute: async () => { throw Error('Unexpected process execution'); },
  });
  assert.deepEqual(await installer.install(), { installed: true, command, args: ['-I', '-m', 'kcsc_mcp'] });
});
