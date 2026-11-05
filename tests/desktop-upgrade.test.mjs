import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileFingerprints, matchingMacDesktopProcesses, requireHostedUpgrade, upgradeErrorDetails, upgradePaths, verifyFileFingerprints, upgradeMetadataRequest } from '../scripts/verify-desktop-upgrade.mjs';

test('upgrade CI authorizes only fixed previous-release metadata without putting credentials in asset URLs',()=>{
  const request=upgradeMetadataRequest({CI:'true',GITHUB_ACTIONS:'true',GITHUB_TOKEN:'synthetic-ci-token'});
  assert.equal(request.url,'https://api.github.com/repos/seominpapa/SiteCAD/releases/tags/v0.16.4');
  assert.equal(request.options.headers.Authorization,'Bearer synthetic-ci-token');
  assert.equal(request.options.redirect,'error');
  assert.equal(upgradeMetadataRequest({}).options.headers.Authorization,undefined);
  assert.throws(()=>upgradeMetadataRequest({GITHUB_TOKEN:'synthetic-ci-token'}),/hosted CI/);
});

test('upgrade failure details retain bounded helper startup evidence without credentials or unrelated fields', () => {
  const error = Object.assign(Error('Helper failed'), { code: 'SITECAD_HELPER', cause: {
    phase: 'helper-start', exitCode: 1, signal: null, spawnCode: 'ENOENT',
    stderr: `${'x'.repeat(5000)}\nParserError api_key=secret-value Bearer bearer-secret https://example.test/private?token=secret`,
    stdout: `${'y'.repeat(5000)}\nBootstrap api_key=output-secret`, bootstrapPhase: 'pid-written', hasPid: true, hasReady: false,
    args: ['private encoded script'], env: { PRIVATE_SENTINEL: 'environment-secret' },
  } });
  const diagnostic = upgradeErrorDetails(error);
  assert.equal(diagnostic.error, 'Helper failed');
  assert.equal(diagnostic.code, 'SITECAD_HELPER');
  assert.deepEqual(Object.keys(diagnostic.cause), ['phase', 'exitCode', 'signal', 'spawnCode', 'stderr', 'stdout', 'bootstrapPhase', 'hasPid', 'hasReady']);
  assert.equal(diagnostic.cause.phase, 'helper-start');
  assert.equal(diagnostic.cause.exitCode, 1);
  assert.equal(diagnostic.cause.signal, null);
  assert.equal(diagnostic.cause.spawnCode, 'ENOENT');
  assert.equal(diagnostic.cause.stderr.length, 4096);
  assert.match(diagnostic.cause.stderr, /ParserError api_key=\[redacted\] Bearer \[redacted\] \[redacted URL\]/);
  assert.equal(diagnostic.cause.stdout.length, 4096);
  assert.match(diagnostic.cause.stdout, /Bootstrap api_key=\[redacted\]/);
  assert.equal(diagnostic.cause.bootstrapPhase, 'pid-written');
  assert.equal(diagnostic.cause.hasPid, true);
  assert.equal(diagnostic.cause.hasReady, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-value|bearer-secret|output-secret|private encoded script|environment-secret|token=secret/);
  for (const marker of ['bootstrap-start', 'helper-started', 'pid-written']) {
    assert.equal(upgradeErrorDetails({ cause: { bootstrapPhase: marker } }).cause.bootstrapPhase, marker);
  }
  const invalid = upgradeErrorDetails({ cause: { bootstrapPhase: 'unexpected secret marker', hasPid: 'true', hasReady: 1 } }).cause;
  assert.equal(invalid.bootstrapPhase, undefined);
  assert.equal(invalid.hasPid, undefined);
  assert.equal(invalid.hasReady, undefined);
  assert.deepEqual(upgradeErrorDetails(Error('Other failure')), { error: 'Other failure', code: undefined, cause: undefined });
});

test('Mac relaunch discovery accepts canonical Unicode paths but rejects other SiteCAD bundles', async () => {
  const expected = '/private/tmp/설치 확인 SiteCAD/SiteCAD.app/Contents/MacOS/SiteCAD';
  const observed = expected.normalize('NFD').replace('/private/tmp/', '/tmp/');
  const other = '/private/tmp/.SiteCAD-previous-123.app/Contents/MacOS/SiteCAD';
  const stdout = `  123 ${observed}\n  124 ${other}\n  125 ${expected} Helper\n  126 /other/SiteCAD.app/Contents/MacOS/SiteCAD\n`;
  const canonicalize = async path => path.replace(/^\/tmp\//, '/private/tmp/');
  assert.deepEqual(await matchingMacDesktopProcesses(stdout, expected, canonicalize), [{ pid: 123, executable: observed }]);
  assert.deepEqual(await matchingMacDesktopProcesses('  123 /gone/SiteCAD', expected, async path => {
    if (path.includes('/gone/')) throw Object.assign(Error('Process exited'), { code: 'ENOENT' });
    return path;
  }), []);
  await assert.rejects(matchingMacDesktopProcesses(` 123 ${expected}`, expected, async () => { throw Error('Unexpected filesystem failure'); }), /filesystem failure/);
});

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
