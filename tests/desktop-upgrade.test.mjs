import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileFingerprints, requireHostedUpgrade, upgradePaths, verifyFileFingerprints } from '../scripts/verify-desktop-upgrade.mjs';

test('desktop upgrade verification only permits a supported clean hosted CI machine', () => {
  const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: tmpdir() };
  assert.doesNotThrow(() => requireHostedUpgrade(hosted, 'darwin', 'arm64'));
  assert.doesNotThrow(() => requireHostedUpgrade(hosted, 'win32', 'x64'));
  for (const env of [{}, { ...hosted, CI: 'false' }, { ...hosted, GITHUB_ACTIONS: 'false' }, { ...hosted, RUNNER_TEMP: 'relative' }]) {
    assert.throws(() => requireHostedUpgrade(env, 'darwin', 'arm64'), /hosted CI/);
  }
  assert.throws(() => requireHostedUpgrade(hosted, 'linux', 'x64'), /supported/);
  assert.throws(() => requireHostedUpgrade(hosted, 'darwin', 'x64'), /supported/);
});

test('upgrade paths keep drawings outside the Mac bundle and use one Windows installation directory', () => {
  const directory = join(tmpdir(), '한글 upgrade');
  const mac = upgradePaths(directory, 'darwin');
  assert.equal(mac.executable, join(mac.installation, 'SiteCAD.app/Contents/MacOS/SiteCAD'));
  assert.equal(mac.drawings, join(mac.installation, 'drawings'));
  assert.equal(mac.appRoot, join(mac.installation, 'SiteCAD.app/Contents/Resources/app'));
  const windows = upgradePaths(directory, 'win32');
  assert.equal(windows.executable, join(windows.installation, 'SiteCAD.exe'));
  assert.equal(windows.drawings, join(windows.installation, 'drawings'));
  assert.equal(windows.appRoot, join(windows.installation, 'resources/app'));
  assert.throws(() => upgradePaths('relative', 'darwin'), /absolute/);
  assert.throws(() => upgradePaths(directory, 'linux'), /supported/);
});

test('upgrade preservation compares bytes of drawings, sidecars, settings and opaque secret sentinels', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-upgrade-preservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = ['도면.dwg', '도면.dwg.sitecad.json', 'drawing-storage.json', 'upgrade-credential-sentinel.enc'].map(name => join(directory, name));
  for (const [index, file] of files.entries()) await writeFile(file, Buffer.from([0, 255, index, 17]));
  const before = await fileFingerprints(files);
  assert.equal(before.length, 4);
  assert.ok(before.every(file => file.bytes === 4 && /^[a-f0-9]{64}$/.test(file.sha256)));
  await verifyFileFingerprints(files, before);
  const original = await readFile(files[2]);
  await writeFile(files[2], Buffer.from([0, 255, 99, 17]));
  await assert.rejects(verifyFileFingerprints(files, before), /changed/);
  await writeFile(files[2], original);
  await rm(files[3]);
  await assert.rejects(verifyFileFingerprints(files, before), /ENOENT/);
});

test('native CI verifies the installer upgrade after fresh-install checks and before uploading proof', async () => {
  const source = await readFile(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8');
  const upgrade = source.indexOf('node scripts/verify-desktop-upgrade.mjs');
  assert.ok(upgrade > source.indexOf('Install Windows setup, verify forced and normal restarts'));
  assert.ok(upgrade < source.indexOf('Save platform installers and verification evidence'));
});
