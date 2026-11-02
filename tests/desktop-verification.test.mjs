import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeDiagnostic, stopDesktop, verifyDesktop } from '../scripts/verify-desktop.mjs';

test('desktop diagnostics redact capability URLs and credentials before writing CI logs', () => {
  const input = 'https://127.0.0.1:4242/?token=private ws://127.0.0.1:1/devtools/private Authorization: Bearer secret-access-token api_key=private-key {"refresh_token":"private-refresh"}';
  const result = sanitizeDiagnostic(input);
  for (const secret of ['4242', 'devtools/private', 'secret-access-token', 'private-key', 'private-refresh']) assert.equal(result.includes(secret), false);
  assert.match(result, /redacted/);
});

test('desktop shutdown resolves if the process already exited, without waiting for another close', async () => {
  const child = Object.assign(new EventEmitter(), {pid:123,exitCode:1,signalCode:null});
  await stopDesktop(child, 20, () => assert.fail('Already exited process must not be stopped again'));
  assert.equal(child.listenerCount('close'), 0);
});

test('desktop shutdown handles close during stop and a bounded missing-close fallback', async () => {
  const child = Object.assign(new EventEmitter(), {pid:123,exitCode:null,signalCode:null});
  await stopDesktop(child, 20, target => target.emit('close', 0));
  assert.equal(child.listenerCount('close'), 0);
  await stopDesktop(child, 5, () => {});
  assert.equal(child.listenerCount('close'), 0);
});

test('a failed executable preserves its startup error and saves a diagnostic after it has already exited', async () => {
  const previous = process.env.CI;
  const previousMode = process.env.SITECAD_VERIFY_SWIFTSHADER;
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-failure-'));
  process.env.CI = 'true';
  delete process.env.SITECAD_VERIFY_SWIFTSHADER;
  try {
    // Node rejects Electron flags without opening any desktop app or personal profile.
    await assert.rejects(verifyDesktop({executable:process.execPath,outputDirectory:directory}), /Desktop exited before verification/);
    const failure = JSON.parse(await readFile(join(directory, 'desktop-verification-failure.json'), 'utf8'));
    assert.equal(failure.stage, 'debugger startup');
    assert.notEqual(failure.exitCode, 0);
    assert.match(failure.error, /Desktop exited before verification/);
    assert.match(failure.stderr, /bad option|unknown option|not allowed|unrecognized/i);
    assert.equal(failure.rendering, 'default');
    assert.doesNotMatch(failure.stderr, /--use-gl|--use-angle/);
  } finally {
    if (previous === undefined) delete process.env.CI; else process.env.CI = previous;
    if (previousMode === undefined) delete process.env.SITECAD_VERIFY_SWIFTSHADER; else process.env.SITECAD_VERIFY_SWIFTSHADER = previousMode;
    await rm(directory, {recursive:true,force:true});
  }
});

test('software rendering requires an explicit CI verifier opt-in and records the launch mode', async () => {
  const previousCI = process.env.CI;
  const previousMode = process.env.SITECAD_VERIFY_SWIFTSHADER;
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-software-rendering-'));
  process.env.CI = 'true';
  process.env.SITECAD_VERIFY_SWIFTSHADER = '1';
  try {
    await assert.rejects(verifyDesktop({executable:process.execPath,outputDirectory:directory}), /Desktop exited before verification/);
    const failure = JSON.parse(await readFile(join(directory, 'desktop-verification-failure.json'), 'utf8'));
    assert.equal(failure.rendering, 'swiftshader');
    assert.match(failure.stderr, /--use-gl=angle/);
    assert.match(failure.stderr, /--use-angle=swiftshader/);
    assert.doesNotMatch(failure.stderr, /unsafe-swiftshader|no-sandbox|disable-gpu/);
  } finally {
    if (previousCI === undefined) delete process.env.CI; else process.env.CI = previousCI;
    if (previousMode === undefined) delete process.env.SITECAD_VERIFY_SWIFTSHADER; else process.env.SITECAD_VERIFY_SWIFTSHADER = previousMode;
    await rm(directory, {recursive:true,force:true});
  }
});

test('desktop verification refuses personal profiles outside a clean CI environment', async () => {
  const previous = process.env.CI;
  delete process.env.CI;
  try { await assert.rejects(verifyDesktop({ executable: process.execPath, outputDirectory: '/tmp/unused' }), /clean CI/); }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('desktop verification rejects relative executables before starting any process', async () => {
  const previous = process.env.CI;
  process.env.CI = 'true';
  try { await assert.rejects(verifyDesktop({ executable: 'SiteCAD.exe', outputDirectory: '/tmp/unused' }), /absolute executable/); }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});
