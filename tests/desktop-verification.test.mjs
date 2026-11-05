import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWindowsDesktop, findDesktopPage, sanitizeDiagnostic, stopDesktop, verifyDesktop, verifyPackagedDrawings, verifyDesktopSecretStore } from '../scripts/verify-desktop.mjs';

test('final desktop bundles retain the exact curated drawings and guide, and reject modified or missing files', async t => {
  const appRoot = await mkdtemp(join(tmpdir(), 'sitecad-packaged-drawings-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  await cp(new URL('../drawings', import.meta.url), join(appRoot, 'drawings'), { recursive: true });
  const files = await verifyPackagedDrawings(appRoot);
  assert.equal(files.length, 8);
  assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0));
  const guide = join(appRoot, 'drawings/Test/테스트_안내.md');
  await writeFile(guide, 'outdated guide');
  await assert.rejects(verifyPackagedDrawings(appRoot), /Packaged test drawing/);
  await rm(guide);
  await assert.rejects(verifyPackagedDrawings(appRoot), { code: 'ENOENT' });
});

test('desktop discovery tolerates a warming debugger without hiding invalid responses', async () => {
  for (const error of [new DOMException('warming up', 'TimeoutError'), Object.assign(new TypeError('fetch failed'), {cause:{code:'ECONNREFUSED'}})]) {
    assert.equal(await findDesktopPage(49152, async () => { throw error; }), undefined);
  }
  assert.equal(await findDesktopPage(49152, async () => ({status:200,json:async () => { throw new DOMException('body warming up', 'TimeoutError'); }})), undefined);
  const page = {type:'page',url:'http://127.0.0.1:49153/',webSocketDebuggerUrl:'ws://127.0.0.1:49152/devtools/page/test'};
  assert.deepEqual(await findDesktopPage(49152, async () => ({status:200,json:async () => [page]})), page);
  assert.equal(await findDesktopPage(49152, async () => ({status:200,json:async () => []})), undefined);
  await assert.rejects(findDesktopPage(49152, async () => ({status:500})), /500/);
  await assert.rejects(findDesktopPage(49152, async () => { throw Error('unexpected failure'); }), /unexpected failure/);
});

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
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-failure-'));
  process.env.CI = 'true';
  try {
    // Node rejects Electron flags without opening any desktop app or personal profile.
    await assert.rejects(verifyDesktop({executable:process.execPath,outputDirectory:directory}), /Desktop exited before verification/);
    const failure = JSON.parse(await readFile(join(directory, 'desktop-verification-failure.json'), 'utf8'));
    assert.equal(failure.stage, 'debugger startup');
    assert.notEqual(failure.exitCode, 0);
    assert.match(failure.error, /Desktop exited before verification/);
    assert.match(failure.stderr, /bad option|unknown option|not allowed|unrecognized/i);
  } finally {
    if (previous === undefined) delete process.env.CI; else process.env.CI = previous;
    await rm(directory, {recursive:true,force:true});
  }
});

test('desktop verification refuses personal profiles outside a clean CI environment', async () => {
  const previous = process.env.CI;
  delete process.env.CI;
  try {
    await assert.rejects(verifyDesktop({ executable: process.execPath, outputDirectory: '/tmp/unused' }), /clean CI/);
    await assert.rejects(closeWindowsDesktop({pid:process.pid}), /clean Windows CI/);
  }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('desktop verification rejects relative executables before starting any process', async () => {
  const previous = process.env.CI;
  process.env.CI = 'true';
  try { await assert.rejects(verifyDesktop({ executable: 'SiteCAD.exe', outputDirectory: '/tmp/unused' }), /absolute executable/); }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('installed desktop credential check writes encrypted bytes and verifies configured state on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.CI;
  process.env.CI = 'true';
  let configured = false, writes = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (options?.method === 'POST') {
      assert.equal(options.headers.Origin, 'http://127.0.0.1:49155');
      assert.equal(JSON.parse(options.body).id, 'openai-api');
      assert.ok(JSON.parse(options.body).apiKey.length >= 16);
      configured = true; writes++;
      await writeFile(join(directory, 'llm-secrets.enc'), 'encrypted-fixture-only');
    }
    return Response.json({ ok: true, data: { active: 'openai-oauth', connections: [{ id: 'openai-api', configured }] } });
  };
  try {
    const options = { baseUrl: 'http://127.0.0.1:49155', dataDir: directory, fetchImpl };
    assert.deepEqual(await verifyDesktopSecretStore(options), { encryptedWriteVerified: true, previousEncryptedReadVerified: false });
    assert.deepEqual(await verifyDesktopSecretStore(options), { encryptedWriteVerified: true, previousEncryptedReadVerified: true });
    assert.equal(writes, 2);
    assert.ok(calls.every(url => url.startsWith('http://127.0.0.1:49155/api/desktop/llm')));
    configured = false;
    await assert.rejects(verifyDesktopSecretStore(options), /Previously saved/);
    assert.equal(writes, 2, 'Do not overwrite a credential that failed to decrypt');
  } finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('installed desktop credential check rejects personal profiles, plaintext output and remote endpoints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.CI;
  try {
    delete process.env.CI;
    await assert.rejects(verifyDesktopSecretStore({ baseUrl: 'http://127.0.0.1:49155', dataDir: directory }), /clean CI/);
    process.env.CI = 'true';
    await assert.rejects(verifyDesktopSecretStore({ baseUrl: 'https://example.test', dataDir: directory }), /local desktop/);
    await assert.rejects(verifyDesktopSecretStore({ baseUrl: 'http://127.0.0.1:49155', dataDir: directory, fetchImpl: async (_url, options) => {
      if (options?.body) await writeFile(join(directory, 'llm-secrets.enc'), options.body);
      return Response.json({ ok: true, data: { active: 'openai-oauth', connections: [{ id: 'openai-api', configured: Boolean(options?.body) }] } });
    } }), /plaintext/);
  } finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});
