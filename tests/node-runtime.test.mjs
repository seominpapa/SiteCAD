import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createNodeSecretStores } from '../lib/node-secret-store.mjs';
import { startLocalWeb } from '../local-web.mjs';
import { defaultDataDir, privateDirectory } from '../lib/local-platform.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'sitecad-node-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function keyring() {
  let password = null; let reads = 0; let writes = 0;
  return { getPassword: async () => { reads++; return password; }, setPassword: async value => { writes++; password = value; },
    get reads() { return reads; }, get writes() { return writes; } };
}
test('Node credentials share one keychain access and authenticated ciphertext survives restart', async t => {
  const dataDir = await directory(t); const entry = keyring();
  const apiKey = randomUUID();
  const stores = createNodeSecretStores({ dataDir, entry });
  assert.equal(await stores.auth.read(), null);
  await stores.auth.write({ refresh_token: 'private-refresh-token' });
  await stores.mcp.write({ API_KEY: apiKey });
  assert.equal(entry.reads, 1); assert.equal(entry.writes, 1);
  const bytes = await readFile(join(dataDir, 'credentials.enc'));
  assert.equal(bytes.includes('private-refresh-token'), false);
  if (process.platform !== 'win32') assert.equal((await stat(join(dataDir, 'credentials.enc'))).mode & 0o777, 0o600);
  const restarted = createNodeSecretStores({ dataDir, entry });
  assert.deepEqual(await restarted.auth.read(), { refresh_token: 'private-refresh-token' });
  await restarted.auth.remove();
  assert.equal(await restarted.auth.read(), null);
  assert.deepEqual(await restarted.mcp.read(), { API_KEY: apiKey });
});
test('tampered, substituted and legacy Electron credentials fail closed without overwriting', async t => {
  const dataDir = await directory(t); const entry = keyring();
  const stores = createNodeSecretStores({ dataDir, entry });
  await stores.auth.write({ secret: 'auth' });
  const file = join(dataDir, 'credentials.enc'); const original = await readFile(file);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await writeFile(file, damaged);
  await assert.rejects(stores.auth.read(), /암호화/);
  await assert.rejects(stores.auth.write({ secret: 'overwrite' }), /암호화/);
  await writeFile(join(dataDir, 'mcp-secrets.enc'), original);
  await assert.rejects(stores.mcp.read(), /암호화/);
  await writeFile(file, 'v10-Electron-private');
  await assert.rejects(stores.auth.read(), /기존|형식/);
  await assert.rejects(stores.auth.write({ secret: true }), /기존|형식/);
  assert.equal(await readFile(file, 'utf8'), 'v10-Electron-private');
});
test('missing or denied keychain never recreates an existing key and denied access is not retried', async t => {
  const dataDir = await directory(t); const entry = keyring();
  await createNodeSecretStores({ dataDir, entry }).auth.write({ token: 'original' });
  const absent = keyring();
  await assert.rejects(createNodeSecretStores({ dataDir, entry: absent }).auth.read(), /키체인|자격 증명/);
  assert.equal(absent.writes, 0);
  await createNodeSecretStores({ dataDir, entry }).mcp.write({ token: 'mcp' });
  await rm(join(dataDir, 'credentials.enc'));
  await assert.rejects(createNodeSecretStores({ dataDir, entry: absent }).auth.write({ login: true }), /키체인|자격 증명/);
  assert.equal(absent.writes, 0);
  await writeFile(join(dataDir, 'credentials.enc'), await readFile(join(dataDir, 'mcp-secrets.enc')));
  let reads = 0;
  const denied = createNodeSecretStores({ dataDir, entry: { getPassword() { reads++; throw Error('secret system detail'); } } });
  await assert.rejects(denied.auth.read(), /키체인|자격 증명/);
  await assert.rejects(denied.mcp.write({ token: true }), /키체인|자격 증명/);
  assert.equal(reads, 1);
});
test('Node web launcher starts the whole controller, authenticates the browser, reuses a running instance and closes', async t => {
  const dataDir = await directory(t); const opened = []; const calls = []; let options;
  const controller = { start: async value => calls.push(['start', value]), close: async () => calls.push(['close']) };
  const first = await startLocalWeb({ dataDir, codexPath: '/fixture/codex', entry: keyring(), openBrowser: async url => opened.push(url),
    controllerFactory: async value => { options = value; return controller; },
    serverFactory: ({ browserAccess }) => createServer(async(req, res) => { if (!await browserAccess.protect(req, res, new URL(req.url, 'http://127.0.0.1').pathname)) return; res.end('private CAD'); }),
    installSignalHandlers: false });
  t.after(() => first.close());
  assert.equal(first.reused, false); assert.equal(options.nodePath, process.execPath); assert.deepEqual(options.nodeEnv, {});
  const entry=await fetch(first.baseUrl); assert.equal(entry.status,200); assert.match(await entry.text(),/이 브라우저로 연결/);
  const launch = await fetch(opened[0], { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  assert.equal(launch.status, 303);
  assert.equal(await (await fetch(first.baseUrl, { headers: { Cookie: cookie } })).text(), 'private CAD');
  const second = await startLocalWeb({ dataDir, openBrowser: async () => { throw Error('second launcher must use running process'); }, installSignalHandlers: false });
  assert.equal(second.reused, true); assert.equal(second.baseUrl, first.baseUrl); assert.equal(opened.length, 2);
  assert.equal(calls.filter(([name]) => name === 'start').length, 1);
  await assert.rejects(options.openExternal('https://auth.openai.com.evil.example/'), /허용/);
  await options.openExternal('https://auth.openai.com/authorize');
  assert.equal(opened.at(-1), 'https://auth.openai.com/authorize');
  const state = JSON.parse(await readFile(join(dataDir, 'local-web-runtime.json'), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['pid', 'port', 'version']);
  await first.close(); await first.close();
  assert.equal(calls.filter(([name]) => name === 'close').length, 1);
  await assert.rejects(readFile(join(dataDir, 'local-web-runtime.json')), { code: 'ENOENT' });
});
test('launcher cleans single instance state if controller startup fails', async t => {
  const dataDir = await directory(t);
  await assert.rejects(startLocalWeb({ dataDir, codexPath: '/fixture/codex', entry: keyring(), installSignalHandlers: false,
    controllerFactory: async () => { throw Error('fixture startup failure'); } }), /fixture startup failure/);
  const instance = await startLocalWeb({ dataDir, codexPath: '/fixture/codex', entry: keyring(), installSignalHandlers: false, openBrowser: async () => {},
    controllerFactory: async () => ({ start: async () => {}, close: async () => {} }), serverFactory: () => createServer((_req, res) => res.end()) });
  await instance.close();
});
test('simultaneous launches keep one controller and quit closes even a failed controller', async t => {
  const dataDir = await directory(t); let created = 0; let actions;
  const options = { dataDir, codexPath: '/fixture/codex', entry: keyring(), openBrowser: async () => {}, installSignalHandlers: false,
    controllerFactory: async () => { created++; return { start: async () => {}, close: async () => { throw Error('fixture close'); } }; },
    serverFactory: value => { actions = value.browserActions; return createServer((_req, res) => res.end()); } };
  const launches = await Promise.all([startLocalWeb(options), startLocalWeb(options)]);
  const owner = launches.find(item => !item.reused);
  assert.equal(created, 1); assert.equal(launches.filter(item => item.reused).length, 1);
  await assert.rejects(owner.close(), /fixture close/);
  await assert.rejects(fetch(owner.baseUrl));
  assert.equal(typeof actions.quit, 'function'); assert.equal(typeof actions.openDrawings, 'function');
});
test('concurrent recovery after a killed launcher retains one live listener without unlinking stale paths', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await directory(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startLocalWeb } from ${JSON.stringify(new URL('../local-web.mjs', import.meta.url).href)};
    import { createServer } from 'node:http';
    await startLocalWeb({dataDir:${JSON.stringify(dataDir)},codexPath:'/fixture/codex',installSignalHandlers:false,
      openBrowser:async()=>{},controllerFactory:async()=>({start:async()=>{},close:async()=>{}}),
      serverFactory:()=>createServer((_req,res)=>res.end())});
    console.log('READY');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('fixture startup timeout')); }, 5000);
    child.once('error', reject);
    child.stdout.once('data', () => { clearTimeout(timer); resolveReady(); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('fixture early exit')); });
  });
  const killed = new Promise(resolveExit => child.once('exit', resolveExit)); child.kill('SIGKILL'); await killed;
  const socketDir = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `sitecad-web-${process.getuid()}`);
  const prefix = createHash('sha256').update(dataDir).digest('hex').slice(0, 24);
  const stalePath = join(socketDir, `${prefix}.sock`);
  const stale = await lstat(stalePath); assert.equal(stale.isSocket(), true);
  t.after(async () => { for (const name of await readdir(socketDir)) if (name.startsWith(prefix)) await rm(join(socketDir, name), { force: true }); });
  let created = 0;
  const options = { dataDir, codexPath: '/fixture/codex', entry: keyring(), openBrowser: async () => {}, installSignalHandlers: false,
    controllerFactory: async () => { created++; return { start: async () => {}, close: async () => {} }; },
    serverFactory: () => createServer((_req, res) => res.end()) };
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => startLocalWeb(options)));
  const launches = attempts.filter(value => value.status === 'fulfilled').map(value => value.value);
  const owner = launches.find(value => !value.reused); if (owner) t.after(() => owner.close());
  assert.equal(attempts.filter(value => value.status === 'rejected').length, 0);
  assert.equal(created, 1); assert.equal(launches.filter(value => value.reused).length, 7);
  const repeated = await startLocalWeb(options);
  assert.equal(repeated.reused, true); assert.equal(repeated.baseUrl, owner.baseUrl);
  // Never unlink a shared stale path: another recovering process can already have bound its replacement.
  assert.equal((await lstat(stalePath)).ino, stale.ino);
  await owner.close();
});

test('Windows credentials use authenticated encryption and fail closed with a platform-specific error', async t => {
  const dataDir = await directory(t); const entry = keyring();
  const secret = randomUUID();
  const stores = createNodeSecretStores({dataDir, entry, platform:'win32'});
  await stores.auth.write({secret});
  assert.deepEqual(await createNodeSecretStores({dataDir,entry,platform:'win32'}).auth.read(), {secret});
  assert.equal((await readFile(join(dataDir,'credentials.enc'))).includes(secret), false);
  await assert.rejects(createNodeSecretStores({dataDir,entry:keyring(),platform:'win32'}).auth.read(), /자격 증명/);
});

test('private launcher directory remains owned and Windows uses the per-user data directory', async t => {
  const path = join(await directory(t), '한글 private');
  await privateDirectory(path);
  assert.equal((await lstat(path)).isDirectory(), true);
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString('base64')}'));$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $p;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $id.Value -or -not $a.AreAccessRulesProtected){throw 'Incorrect private owner'};foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $id.Value){throw 'Another principal has access'}}`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')]);
  }
  assert.match(defaultDataDir('win32'), /SiteCAD Web$/);
  assert.match(defaultDataDir('darwin'), /Library[/\\]Application Support[/\\]SiteCAD Web$/);
});
