import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createDesktopUpdater, updateFromRelease, downloadUpdate } from '../desktop/updater.mjs';

const bytes = Buffer.from('verified installer fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const options = { currentVersion: '0.16.2', platform: 'win32', arch: 'x64' };
const release = (version = '0.16.3', platform = 'win32') => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ name: `SiteCAD-${version}-${platform === 'win32' ? 'Windows-x64-Setup.exe' : 'macOS-arm64.dmg'}`,
    browser_download_url: `https://github.com/seominpapa/SiteCAD/releases/download/v${version}/SiteCAD-${version}-${platform === 'win32' ? 'Windows-x64-Setup.exe' : 'macOS-arm64.dmg'}`,
    digest: `sha256:${sha256}`, size: bytes.length, state: 'uploaded' }],
});
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-updater-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('only a newer stable release and exact supported platform installer are selected', () => {
  assert.equal(updateFromRelease(release(), options).version, '0.16.3');
  assert.equal(updateFromRelease(release('0.17.0', 'darwin'), { ...options, platform: 'darwin', arch: 'arm64' }).name, 'SiteCAD-0.17.0-macOS-arm64.dmg');
  assert.equal(updateFromRelease(release('0.16.10'), { ...options, currentVersion: '0.16.9' }).version, '0.16.10');
  for (const version of ['0.16.2', '0.15.9']) assert.equal(updateFromRelease(release(version), options), null);
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.17.0-beta.1' }]) {
    assert.equal(updateFromRelease({ ...release(), ...change }, options), null);
  }
  assert.throws(() => updateFromRelease(release(), { ...options, platform: 'darwin' }));
  assert.throws(() => updateFromRelease(release(), { ...options, currentVersion: 'not a version' }));
});

test('untrusted asset URLs, digests, sizes and ambiguous installers fail closed', () => {
  const original = release();
  const asset = original.assets[0];
  for (const change of [
    { browser_download_url: asset.browser_download_url.replace('github.com/', 'evil.test/') },
    { browser_download_url: asset.browser_download_url + '?token=unexpected' },
    { browser_download_url: asset.browser_download_url.replace('https:', 'http:') },
    { digest: null }, { digest: 'sha256:bad' }, { size: -1 }, { size: 2 ** 32 }, { state: 'starter' },
  ]) assert.throws(() => updateFromRelease({ ...original, assets: [{ ...asset, ...change }] }, options));
  assert.throws(() => updateFromRelease({ ...original, assets: [asset, asset] }, options));
});

test('download verifies bytes and SHA-256 before returning the private file', async t => {
  const directory = await temp(t), progress = [];
  const update = updateFromRelease(release(), options);
  const file = await downloadUpdate(update, { directory, fetchImpl: async (url, init) => {
    assert.equal(url, release().assets[0].browser_download_url);
    assert.equal(init.redirect, 'manual');
    assert.equal(Object.hasOwn(init.headers, 'Authorization'), false);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  }, onProgress: value => progress.push(value) });
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(progress.at(-1), 1);
});

test('download rejects corruption, truncation, unexpected redirects and oversize responses without retaining a partial installer', async t => {
  const directory = await temp(t), update = updateFromRelease(release(), options);
  for (const response of [
    new Response(Buffer.alloc(bytes.length, 0)), new Response(bytes.subarray(0, 3)), new Response(Buffer.alloc(bytes.length + 1)),
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    new Response(null, { status: 302, headers: { location: 'https://evil.test/installer' } }),
    new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
    new Response('unavailable', { status: 503 }),
  ]) {
    await assert.rejects(downloadUpdate(update, { directory, fetchImpl: async () => response }));
    assert.deepEqual(await readdir(directory), []);
  }
});

test('GitHub asset redirects are allowed without forwarding credentials; redirect loops stop', async t => {
  const directory = await temp(t), update = updateFromRelease(release(), options);
  let calls = 0;
  await downloadUpdate(update, { directory, fetchImpl: async (url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return ++calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture' } }) : new Response(bytes);
  } });
  assert.equal(calls, 2);
  const loopDirectory = await temp(t);
  await assert.rejects(downloadUpdate(update, { directory: loopDirectory, fetchImpl: async () => new Response(null, { status: 302, headers: { location: update.url } }) }));
  assert.deepEqual(await readdir(loopDirectory), []);
});

async function flow(t, responses = [1, 1], overrides = {}) {
  const directory = await temp(t), events = [], prompts = [];
  const updater = createDesktopUpdater({ ...options, updatesDir: directory,
    fetchImpl: async url => {
      events.push(url.includes('api.github.com') ? 'check' : 'download');
      return url.includes('api.github.com') ? Response.json(release()) : new Response(bytes);
    },
    showMessage: async message => { prompts.push(message); return { response: responses.shift() ?? 0 }; },
    onProgress: value => events.push(['progress', value]),
    prepareInstall: async ({ file }) => {
      assert.deepEqual(await readFile(file), bytes);
      events.push('prepare');
      return { install: async () => events.push('install'), cleanup: async () => events.push('cleanup') };
    },
    install: async prepared => { await prepared.install(); events.push('quit'); },
    ...overrides,
  });
  return { updater, directory, events, prompts };
}

test('startup decline never downloads, installs or quits the working app', async t => {
  const f = await flow(t, [0]);
  assert.equal((await f.updater.check()).status, 'declined');
  assert.deepEqual(f.events.filter(e => typeof e === 'string'), ['check']);
  assert.deepEqual(await readdir(f.directory), []);
});

test('download consent is separate from save-and-quit install consent', async t => {
  const f = await flow(t, [1, 0]);
  assert.equal((await f.updater.check()).status, 'deferred');
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].detail, /저장/);
  assert.deepEqual(f.events.filter(e => typeof e === 'string'), ['check', 'download']);
  assert.deepEqual(await readdir(f.directory), []);
});

test('verified installer is handed off only after both consents and cache survives parent exit', async t => {
  const f = await flow(t);
  assert.equal((await f.updater.check()).status, 'installing');
  assert.deepEqual(f.events.filter(e => typeof e === 'string'), ['check', 'download', 'prepare', 'install', 'quit']);
  assert.equal((await readdir(f.directory)).length, 1);
});

test('offline startup remains usable; manual checks explain failure and reset progress', async t => {
  const f = await flow(t, [], { fetchImpl: async () => { throw Error('private transport diagnostic'); } });
  assert.equal((await f.updater.check()).status, 'failed');
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.updater.check({ manual: true })).status, 'failed');
  assert.equal(f.prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.prompts), /private transport diagnostic/);
  assert.deepEqual(f.events.at(-1), ['progress', -1]);
});

test('failed installer preparation never quits and removes the downloaded cache', async t => {
  const f = await flow(t, [1, 1], { prepareInstall: async () => { throw Error('permission denied'); } });
  assert.equal((await f.updater.check()).status, 'failed');
  assert.equal(f.events.includes('quit'), false);
  assert.deepEqual(await readdir(f.directory), []);
});

test('up-to-date manual checks explain status; unsupported drawing storage blocks installation', async t => {
  const current = await flow(t, [], { fetchImpl: async () => Response.json(release('0.16.2')) });
  assert.equal((await current.updater.check()).status, 'current');
  assert.equal(current.prompts.length, 0);
  assert.equal((await current.updater.check({ manual: true })).status, 'current');
  assert.equal(current.prompts.length, 1);
  const blocked = await flow(t, [1, 1], { canInstall: async () => false });
  assert.equal((await blocked.updater.check()).status, 'blocked');
  assert.equal(blocked.events.includes('prepare'), false);
  assert.deepEqual(await readdir(blocked.directory), []);
});

test('concurrent checks share no work and cancellation leaves the app running', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await flow(t, [], { fetchImpl: async (_url, { signal }) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const first = f.updater.check();
  await waiting;
  assert.equal((await f.updater.check()).status, 'busy');
  f.updater.cancel();
  assert.equal((await first).status, 'failed');
  assert.equal(f.prompts.length, 0);
});

test('failed helper handoff cleans the preparation and permits another check', async t => {
  const f = await flow(t, [1, 1], { install: async () => { throw Error('helper failed to become ready'); } });
  assert.equal((await f.updater.check()).status, 'failed');
  assert.equal(f.events.includes('cleanup'), true);
  assert.equal(f.events.includes('quit'), false);
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await f.updater.check()).status, 'declined');
});

test('aborted downloads never retain partial installers', async t => {
  const directory = await temp(t), controller = new AbortController();
  const body = new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 4)); } });
  await assert.rejects(downloadUpdate(updateFromRelease(release(), options), {
    directory, signal: controller.signal, fetchImpl: async () => new Response(body),
    onProgress: () => controller.abort(),
  }));
  assert.deepEqual(await readdir(directory), []);
});

test('storage is checked again after staging and a changed folder blocks handoff', async t => {
  let checks = 0;
  const f = await flow(t, [1, 1], { canInstall: async () => ++checks === 1 });
  assert.equal((await f.updater.check()).status, 'blocked');
  assert.equal(checks, 2);
  assert.deepEqual(f.events.filter(e => typeof e === 'string'), ['check', 'download', 'prepare', 'cleanup']);
  assert.deepEqual(await readdir(f.directory), []);
});

test('shutdown cancellation waits for native preparation and cleanup to finish', async t => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const staging = new Promise(resolve => { finish = resolve; });
  const events = [];
  const f = await flow(t, [1, 1], { prepareInstall: async () => {
    enter();
    await staging;
    return { cleanup: async () => { events.push('cleaned'); } };
  } });
  const check = f.updater.check();
  await entered;
  let settled = false;
  const shutdown = f.updater.cancel().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  await shutdown;
  assert.equal((await check).status, 'cancelled');
  assert.deepEqual(events, ['cleaned']);
  assert.deepEqual(await readdir(f.directory), []);
});

test('repeated native close and quit requests cannot bypass pending update cleanup', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  let finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const events = [];
  const context = { app: { quit: () => events.push('quit') }, closeServices: () => cleanup,
    dialog: { showMessageBox: async () => ({ response: 1 }) } };
  runInNewContext(`let closing=false, exitReady=false, closingPrompt=false, updateHandoff=false, mainWindow={};
    ${source.slice(source.indexOf('async function confirmClose('), source.indexOf('async function updateMessage('))}
    globalThis.close = confirmClose;
    globalThis.beforeQuit = event => ${source.match(/app\.on\('before-quit', event => (\{[^\n]+\})\);/)[1]};`, context);
  const event = () => ({ preventDefault() { events.push('prevented'); } });
  const first = context.close(event());
  await new Promise(resolve => setImmediate(resolve));
  await context.close(event());
  context.beforeQuit(event());
  assert.deepEqual(events, ['prevented', 'prevented', 'prevented']);
  finish();
  await first;
  assert.deepEqual(events, ['prevented', 'prevented', 'prevented', 'quit']);
  context.beforeQuit(event());
  assert.equal(events.at(-1), 'quit');
});
