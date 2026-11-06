import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { applyWebUpdate, restartWeb, runWebUpdate, webUpdateEntries } from '../lib/web-update-helper.mjs';
import { checkedWebArchiveNames, createWebUpdater, prepareWebUpdate, isWithinWebPath } from '../lib/web-update.mjs';

const directories = ['lib', 'public', 'skills', 'desktop', 'vendor', 'scripts', 'fixtures'];
async function temp(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sitecad-web-update-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function bundle(root, version = '0.16.4', platform = 'darwin') {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'drawings'), { recursive: true });
  for (const name of webUpdateEntries) {
    if (directories.includes(name)) { await mkdir(join(root, name)); await writeFile(join(root, name, 'content'), version); }
    else await writeFile(join(root, name), version);
  }
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts/bootstrap-local-web.sh'), 'true');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sitecad-local', version }));
  await writeFile(join(root, '.sitecad-web-release.json'), JSON.stringify({ type: 'sitecad-local-web', version, platform }));
}

test('web archive names reject traversal, unsupported roots, duplicate case names and special paths', () => {
  assert.deepEqual(checkedWebArchiveNames(['SiteCAD/', 'SiteCAD/lib/', 'SiteCAD/lib/web-update.mjs', 'SiteCAD/drawings/Test/a.dwg']), ['SiteCAD/', 'SiteCAD/lib/', 'SiteCAD/lib/web-update.mjs', 'SiteCAD/drawings/Test/a.dwg']);
  for (const name of ['../a', '/SiteCAD/a', 'SiteCAD/../a', 'SiteCAD/lib/../../a', 'SiteCAD/lib\\a', 'SiteCAD/lib/C:a', 'SiteCAD/.env', 'SiteCAD/a\0b', 'SiteCAD//lib/a']) assert.throws(() => checkedWebArchiveNames([name]));
  assert.throws(() => checkedWebArchiveNames(['SiteCAD/lib/a', 'SiteCAD/lib/A']));
  assert.throws(() => checkedWebArchiveNames([]));
});

test('web update replaces only managed app files and preserves drawings, runtime, dependencies and private files', async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), staged = join(root, 'new'), backup = join(root, 'backup');
  await bundle(target, '0.16.3'); await bundle(staged);
  for (const directory of ['drawings', '.runtime', 'runtime', 'node_modules']) { await mkdir(join(target, directory), { recursive: true }); await writeFile(join(target, directory, 'private'), `private-${directory}`); }
  await writeFile(join(target, '.env'), 'private config');
  await applyWebUpdate({ target, staged, backup, version: '0.16.4' });
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.4');
  assert.equal(JSON.parse(await readFile(join(backup, 'package.json'))).version, '0.16.3');
  for (const directory of ['drawings', '.runtime', 'runtime', 'node_modules']) assert.equal(await readFile(join(target, directory, 'private'), 'utf8'), `private-${directory}`);
  assert.equal(await readFile(join(target, '.env'), 'utf8'), 'private config');
});

test('partial installation failure restores every previous managed file', async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), staged = join(root, 'new'), backup = join(root, 'backup');
  await bundle(target, '0.16.3'); await bundle(staged);
  let failed = false;
  await assert.rejects(applyWebUpdate({ target, staged, backup, version: '0.16.4' }, { move: async (source, destination) => {
    if (!failed && source === join(staged, 'public')) { failed = true; throw Error('locked file'); }
    return rename(source, destination);
  } }));
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.3');
  assert.equal(await readFile(join(target, 'public/content'), 'utf8'), '0.16.3');
  assert.equal(await readFile(join(target, 'lib/content'), 'utf8'), '0.16.3');
});

test('development checkouts and wrong release manifests cannot be overwritten', async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), staged = join(root, 'new');
  await bundle(target, '0.16.3'); await bundle(staged);
  await mkdir(join(target, '.git'));
  await assert.rejects(applyWebUpdate({ target, staged, backup: join(root, 'backup'), version: '0.16.4' }));
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.3');
  await rm(join(target, '.git'), { recursive: true });
  await assert.rejects(applyWebUpdate({ target, staged, backup: join(root, 'backup'), version: '0.16.5' }));
});

for (const platform of ['darwin', 'win32']) test(`${platform} preparation verifies archives, stages privately and waits for helper readiness`, async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), updatesDir = join(root, 'updates');
  await bundle(target, '0.16.3', platform);
  let extracted = false, launched = false;
  const prepared = await prepareWebUpdate({ file: join(root, 'archive.zip'), version: '0.16.4', target, updatesDir, platform }, {
    executeCommand: async (command, args) => {
      if (command.endsWith('unzip')) return { stdout: args.includes('-1') ? 'SiteCAD/\nSiteCAD/lib/\n' : '-rw-r--r--  3.0 unx 32 tx defN x x SiteCAD/package.json\n' };
      if (command.endsWith('ditto')) { extracted = true; await bundle(join(args.at(-1), 'SiteCAD'), '0.16.4', platform); return { stdout: '' }; }
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      if (script.includes('OpenRead')) return { stdout: JSON.stringify(['SiteCAD/', 'SiteCAD/lib/']) };
      const values = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map(match => Buffer.from(match[1], 'base64').toString());
      extracted = true; await bundle(join(values[1], 'SiteCAD'), '0.16.4', platform); return { stdout: '' };
    },
    spawnImpl: (_command, args) => {
      const child = new EventEmitter(); child.exitCode = null; child.kill = () => {}; child.unref = () => { launched = true; };
      void readFile(args[1], 'utf8').then(JSON.parse).then(job => writeFile(job.ready, 'ready')); return child;
    },
  });
  assert.equal(extracted, true); await prepared.install(); assert.equal(launched, true);
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.3');
  await prepared.cleanup(); assert.deepEqual(await readdir(updatesDir), []);
});

test('restart uses literal platform arguments instead of shell-interpolated installation paths', async () => {
  const calls = [], spawnImpl = (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  await restartWeb('/tmp/한글 & data/SiteCAD', 'darwin', spawnImpl);
  await restartWeb('/tmp/한글 & data/SiteCAD', 'win32', spawnImpl);
  assert.deepEqual(calls[0][1], ['/tmp/한글 & data/SiteCAD/Start SiteCAD.command']);
  assert.equal(calls[1][1].at(-1), '/tmp/한글 & data/SiteCAD/scripts/bootstrap-local-web.ps1');
  assert.equal(calls.every(call => call[2].shell === undefined), true);
});

test('detached helper waits for launcher exit, records installation and restarts the same web folder', async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), staged = join(root, 'new'), job = join(root, 'updates/job');
  await bundle(target, '0.16.3'); await bundle(staged); await mkdir(job, { recursive: true });
  const jobPath = join(job, 'job.json'), result = join(root, 'updates/web-update-result.json');
  await writeFile(jobPath, JSON.stringify({ target, staged, backup: join(job, 'previous'), version: '0.16.4', platform: 'darwin', parentPid: 12345, result, ready: join(job, 'ready') }));
  let checks = 0, waits = 0, restarted;
  await runWebUpdate(jobPath, { running: () => ++checks < 3, wait: async () => { waits++; assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.3'); }, restart: (...args) => { restarted = args; } });
  assert.equal(waits, 2); assert.deepEqual(restarted, [target, 'darwin']);
  assert.equal((JSON.parse(await readFile(result))).status, 'installed');
  assert.equal(await readFile(join(job, 'ready'), 'utf8'), 'ready');
});

test('a helper cannot update while the original launcher remains running', async t => {
  const root = await temp(t), target = join(root, 'SiteCAD'), staged = join(root, 'new'), job = join(root, 'updates/job');
  await bundle(target, '0.16.3'); await bundle(staged); await mkdir(job, { recursive: true });
  const jobPath = join(job, 'job.json');
  await writeFile(jobPath, JSON.stringify({ target, staged, backup: join(job, 'previous'), version: '0.16.4', platform: 'win32', parentPid: 12345, result: join(root, 'updates/web-update-result.json'), ready: join(job, 'ready') }));
  let restarted = false;
  await assert.rejects(runWebUpdate(jobPath, { running: () => true, wait: async () => {}, restart: () => { restarted = true; } }));
  assert.equal(restarted, false); assert.equal(JSON.parse(await readFile(join(target, 'package.json'))).version, '0.16.3');
});

test('development web builds stay disabled while packaged web builds check only the matching ZIP', async t => {
  const root = await temp(t), dataDir = join(root, 'profile'), appRoot = join(root, 'SiteCAD'); await bundle(appRoot, '0.16.3');
  const bytes = Buffer.from('zip'), name = 'SiteCAD-0.16.4-local-web-macOS.zip'; let checks = 0;
  const parameters = { appRoot, dataDir, currentVersion: '0.16.3', drawingDirectory: () => join(appRoot, 'drawings'), onInstall: async () => {},
    fetchImpl: async () => { checks++; return Response.json({ tag_name: 'v0.16.4', draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/seominpapa/SiteCAD/releases/download/v0.16.4/${name}` }] }); } };
  const updater = await createWebUpdater(parameters); await updater.check();
  assert.equal(updater.status().availableVersion, process.platform === 'darwin' && process.arch === 'arm64' ? '0.16.4' : undefined); assert.equal(checks, 1);
  await mkdir(join(appRoot, '.git')); const development = await createWebUpdater(parameters); await development.check(); assert.equal(development.status().supported, false); assert.equal(checks, 1);
});

 test('Windows data folders on another drive are outside managed application paths', () => {
  assert.equal(isWithinWebPath('C:\\SiteCAD\\lib', 'D:\\Drawings', win32), false);
  assert.equal(isWithinWebPath('C:\\SiteCAD\\lib', 'C:\\SiteCAD\\lib\\private', win32), true);
});

test('web update waits for fresh browser consent after download before preparing or closing', async t => {
  const root = await temp(t), appRoot = join(root, 'SiteCAD'), dataDir = join(root, 'profile'); await bundle(appRoot, '0.16.3');
  const bytes = Buffer.from('archive'), name = `SiteCAD-0.16.4-local-web-${process.platform === 'win32' ? 'Windows' : 'macOS'}.zip`;
  let closed = false, prepared = false;
  const updater = await createWebUpdater({ appRoot, dataDir, currentVersion: '0.16.3', drawingDirectory: () => join(appRoot, 'drawings'), onInstall: async () => { closed = true; },
    prepareInstall: async () => { prepared = true; return { install: async () => {}, cleanup: async () => {} }; },
    fetchImpl: async url => url.includes('api.github.com') ? Response.json({ tag_name: 'v0.16.4', draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/seominpapa/SiteCAD/releases/download/v0.16.4/${name}` }] }) : new Response(bytes),
  });
  await updater.check(); await updater.install();
  for (let i = 0; i < 100 && updater.status().status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updater.status().status, 'ready'); assert.equal(updater.status().busy, false);
  assert.equal(closed, false); assert.equal(prepared, false);
  await updater.install();
  for (let i = 0; i < 100 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true); assert.equal(prepared, true); await updater.cancel();
});

test('restart launch failures are reported instead of claiming a successful relaunch', async () => {
  await assert.rejects(restartWeb('/tmp/SiteCAD', 'win32', () => {
    const child = new EventEmitter(); child.unref=()=>{}; queueMicrotask(()=>child.emit('error', Error('launcher blocked'))); return child;
  }), /launcher blocked/);
});

test('a prior failed installation remains visible after startup version checks', async t => {
  const root=await temp(t),appRoot=join(root,'SiteCAD'),dataDir=join(root,'profile'); await bundle(appRoot); await mkdir(join(dataDir,'updates'),{recursive:true});
  await writeFile(join(dataDir,'updates/web-update-result.json'),JSON.stringify({status:'failed',code:'apply',version:'0.16.4'}));
  const updater=await createWebUpdater({appRoot,dataDir,currentVersion:'0.16.4',drawingDirectory:()=>join(appRoot,'drawings'),onInstall:async()=>{},fetchImpl:async()=>Response.json({tag_name:'v0.16.4',draft:false,prerelease:false,assets:[]})});
  await updater.check(); assert.equal(updater.status().lastInstallFailed,true);
});

test('deferred asynchronous busy status blocks preparation and is checked again before handoff', async t => {
  const root=await temp(t),appRoot=join(root,'SiteCAD'),dataDir=join(root,'profile');await bundle(appRoot,'0.16.3');
  const bytes=Buffer.from('archive'),name=`SiteCAD-0.16.4-local-web-${process.platform==='win32'?'Windows':'macOS'}.zip`;
  let statusCheck=async()=>false,prepared=false,handedOff=false,cleaned=false;
  const updater=await createWebUpdater({appRoot,dataDir,currentVersion:'0.16.3',drawingDirectory:()=>join(appRoot,'drawings'),isBusy:()=>statusCheck(),onInstall:async()=>{handedOff=true;},
    prepareInstall:async()=>{prepared=true;statusCheck=async()=>true;return{install:async()=>{handedOff=true;},cleanup:async()=>{cleaned=true;}};},
    fetchImpl:async url=>url.includes('api.github.com')?Response.json({tag_name:'v0.16.4',draft:false,prerelease:false,assets:[{name,state:'uploaded',size:bytes.length,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,browser_download_url:`https://github.com/seominpapa/SiteCAD/releases/download/v0.16.4/${name}` }]}):new Response(bytes),
  });
  await updater.check();await updater.install();
  for(let i=0;i<100&&updater.status().status!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,10));
  let resolveStatus;statusCheck=()=>new Promise(resolve=>{resolveStatus=resolve;});
  const approval=updater.install();let settled=false;void approval.then(()=>{settled=true;},()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(prepared,false);
  resolveStatus(true);await assert.rejects(approval);assert.equal(prepared,false);assert.equal(handedOff,false);
  statusCheck=async()=>false;await updater.install();
  for(let i=0;i<100&&updater.status().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(prepared,true);assert.equal(handedOff,false);assert.equal(cleaned,true);await updater.cancel();
});

test('drawing folders reached through a parent symlink cannot point into replaced application files', async t => {
  const root=await temp(t),appRoot=join(root,'SiteCAD'),dataDir=join(root,'profile');await bundle(appRoot,'0.16.3');
  await mkdir(join(appRoot,'lib/user-drawings'));await symlink(join(appRoot,'lib'),join(root,'shortcut'),'junction');
  const bytes=Buffer.from('archive'),name=`SiteCAD-0.16.4-local-web-${process.platform==='win32'?'Windows':'macOS'}.zip`;
  let prepared=false,handedOff=false;
  const updater=await createWebUpdater({appRoot,dataDir,currentVersion:'0.16.3',drawingDirectory:()=>join(root,'shortcut/user-drawings'),onInstall:async()=>{handedOff=true;},
    prepareInstall:async()=>{prepared=true;return{install:async()=>{handedOff=true;},cleanup:async()=>{}};},
    fetchImpl:async url=>url.includes('api.github.com')?Response.json({tag_name:'v0.16.4',draft:false,prerelease:false,assets:[{name,state:'uploaded',size:bytes.length,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,browser_download_url:`https://github.com/seominpapa/SiteCAD/releases/download/v0.16.4/${name}` }]}):new Response(bytes),
  });
  await updater.check();await updater.install();
  for(let i=0;i<100&&updater.status().status!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,10));
  await updater.install();
  for(let i=0;i<100&&updater.status().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(prepared,false);assert.equal(handedOff,false);await updater.cancel();
});
