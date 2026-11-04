import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareUpdateInstall, windowsUpdateArguments } from '../desktop/update-install.mjs';

async function fixture(t, platform = 'darwin') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sitecad-update-install-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const updatesDir = join(directory, '설정 폴더', 'updates');
  await mkdir(updatesDir, { recursive: true });
  const file = join(updatesDir, `SiteCAD-0.16.3-${platform === 'darwin' ? 'macOS-arm64.dmg' : 'Windows-x64-Setup.exe'}`);
  await writeFile(file, 'verified package fixture');
  const executable = platform === 'darwin' ? join(directory, "한글 'app'", 'SiteCAD.app/Contents/MacOS/SiteCAD') : join(directory, "한글 'app'", 'SiteCAD.exe');
  await mkdir(join(executable, '..'), { recursive: true });
  await writeFile(executable, 'old executable');
  await writeFile(join(directory, '설정 폴더', 'credentials.enc'), 'encrypted credential fixture');
  await mkdir(join(directory, 'drawings'));
  await writeFile(join(directory, 'drawings', '사용자.dwg'), 'drawing fixture');
  return { directory, file, executable, updatesDir, version: '0.16.3', platform, arch: platform === 'darwin' ? 'arm64' : 'x64', parentPid: process.pid };
}

async function acknowledgeFakeHelper(environment) {
  if (environment.SITECAD_UPDATE_PID) await writeFile(environment.SITECAD_UPDATE_PID, '2147483646');
  await writeFile(environment.SITECAD_UPDATE_READY, 'ready');
}

function fakeCommands(options, { version = '0.16.3', identifier = 'com.sitecad.desktop', arch = 'arm64', fail } = {}) {
  const calls = [];
  const executeCommand = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    if (fail?.(command, args)) throw Error('native command fixture failed');
    if (command.endsWith('/hdiutil') && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      const source = join(mount, 'SiteCAD.app/Contents/MacOS');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'SiteCAD'), 'new executable');
    }
    if (command.endsWith('/ditto')) await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
    if (command.endsWith('/PlistBuddy')) {
      const key = args[1];
      return { stdout: key.endsWith('CFBundleIdentifier') ? identifier : key.endsWith('CFBundleExecutable') ? 'SiteCAD' : version };
    }
    return { stdout: command.endsWith('/lipo') ? arch : '' };
  };
  return { calls, executeCommand };
}

test('Windows update arguments retain the exact destination without force closing or deleting data', () => {
  const destination = "C:\\사용자 폴더\\'SiteCAD'";
  assert.deepEqual(windowsUpdateArguments(destination), ['/SILENT', '/SP-', '/NORESTART', '/NOCLOSEAPPLICATIONS', '/NOFORCECLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', `/DIR="${destination}"`]);
  for (const invalid of ['', 'relative', 'C:\\bad"path', 'C:\\bad\npath']) assert.throws(() => windowsUpdateArguments(invalid));
});

test('invalid platform, version, package, process, or installation path fails before any install', async t => {
  const options = await fixture(t);
  for (const bad of [
    { version: '0.16.3;rm' }, { platform: 'linux' }, { arch: 'x64' }, { parentPid: 0 },
    { parentPid: '12' }, { executable: 'relative' }, { file: join(options.directory, 'other.dmg') },
  ]) await assert.rejects(prepareUpdateInstall({ ...options, ...bad }));
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
});

test('Mac staging validates bundle identity, version, architecture and integrity, and cancellation preserves user data', async t => {
  const options = await fixture(t);
  const commands = fakeCommands(options);
  const prepared = await prepareUpdateInstall(options, commands);
  assert.equal(prepared.resultFile, join(options.updatesDir, 'install-result.json'));
  const staged = commands.calls.find(call => call.command.endsWith('/ditto')).args[1];
  assert.ok(!staged.startsWith(join(options.executable, '../../..')));
  assert.equal(await readFile(join(staged, 'Contents/MacOS/SiteCAD'), 'utf8'), 'new executable');
  assert.ok(commands.calls.some(call => call.command.endsWith('/codesign') && call.args.includes('--strict')));
  const copy = commands.calls.find(call => call.command.endsWith('/ditto'));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
  assert.equal(copy.options.env?.PATH, process.platform === 'win32' ? `${systemRoot}\\System32;${systemRoot}` : '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(copy.options.env.DITTONORSRC, undefined);
  assert.ok(commands.calls.some(call => call.command.endsWith('/hdiutil') && call.args[0] === 'detach'));
  await prepared.cleanup();
  await assert.rejects(stat(staged), { code: 'ENOENT' });
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  assert.equal(await readFile(join(options.directory, '설정 폴더', 'credentials.enc'), 'utf8'), 'encrypted credential fixture');
  assert.equal(await readFile(join(options.directory, 'drawings', '사용자.dwg'), 'utf8'), 'drawing fixture');
  await assert.rejects(prepared.install(), /취소|cancel/i);
});

test('Mac rejects wrong metadata, incompatible architecture, failed signatures and detaches the image without replacing app', async t => {
  const options = await fixture(t);
  for (const bad of [{ version: '0.16.2' }, { identifier: 'other.app' }, { arch: 'x86_64' }, { fail: command => command.endsWith('/codesign') }]) {
    const commands = fakeCommands(options, bad);
    await assert.rejects(prepareUpdateInstall(options, commands));
    assert.ok(commands.calls.some(call => call.command.endsWith('/hdiutil') && call.args[0] === 'detach'));
    assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  }
});

test('Mac refuses a symlink installation and app translocation before staging', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t);
  const app = join(options.executable, '../../..');
  const linked = join(options.directory, 'Linked.app');
  await symlink(app, linked);
  await assert.rejects(prepareUpdateInstall({ ...options, executable: join(linked, 'Contents/MacOS/SiteCAD') }));
  await assert.rejects(prepareUpdateInstall({ ...options, executable: '/private/var/AppTranslocation/id/d/SiteCAD.app/Contents/MacOS/SiteCAD' }));
});

test('Windows preparation leaves existing app intact, uses a private helper with no credential environment, and waits ready acknowledgement', async t => {
  const options = await fixture(t, 'win32');
  let launched;
  const spawnImpl = (command, args, spawnOptions) => {
    launched = { command, args, options: spawnOptions };
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => {};
    child.exitCode = 0; // The short bootstrap may exit before the independent helper acknowledges.
    queueMicrotask(() => { void acknowledgeFakeHelper(spawnOptions.env); });
    return child;
  };
  const prepared = await prepareUpdateInstall(options, { spawnImpl });
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  await prepared.install();
  assert.match(launched.command, /powershell\.exe$/i);
  assert.ok(launched.args.includes('-EncodedCommand'));
  const code = Buffer.from(launched.args.at(-1), 'base64').toString('utf16le');
  assert.ok(!code.includes(options.file), 'Path is data, not code');
  assert.equal(launched.options.env.SITECAD_UPDATE_INSTALLER, options.file);
  assert.equal(launched.options.env.SITECAD_UPDATE_DESTINATION, join(options.executable, '..'));
  assert.equal(launched.options.shell, false);
  assert.equal(launched.options.detached, false, 'Windows PowerShell must retain a usable console host until script startup');
  assert.equal(launched.options.env.ACCESS_TOKEN, undefined);
  assert.equal(launched.options.env.OPENAI_API_KEY, undefined);
  assert.ok(!code.includes('ExecutionPolicy'));
  assert.match(code, /Start-Process/);
  assert.equal(await readFile(launched.options.env.SITECAD_UPDATE_ARMED, 'utf8'), 'install');
  assert.match(Buffer.from(launched.options.env.SITECAD_UPDATE_CODE, 'base64').toString('utf16le'), /SITECAD_UPDATE_ARMED/);
  await prepared.cleanup();
  assert.equal(await readFile(options.file, 'utf8'), 'verified package fixture');
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
});

test('helper startup failure and acknowledgement timeout do not replace the running application', async t => {
  const options = await fixture(t, 'win32');
  for (const failure of ['error', 'timeout']) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.unref = () => {};
    child.kill = () => { child.exitCode = 1; };
    const prepared = await prepareUpdateInstall(options, { readyTimeoutMs: 30, spawnImpl: () => {
      if (failure === 'error') queueMicrotask(() => child.emit('error', Error('failed spawn')));
      return child;
    } });
    await assert.rejects(prepared.install());
    await prepared.cleanup();
    assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  }
});

test('a ready file without an independent helper PID never arms an orphaned Windows install', async t => {
  const options = await fixture(t, 'win32');
  let environment;
  const prepared = await prepareUpdateInstall(options, { readyTimeoutMs: 30, spawnImpl: (_command, _args, settings) => {
    environment = settings.env;
    const child = new EventEmitter();
    child.exitCode = 0;
    child.kill = () => {};
    child.unref = () => {};
    queueMicrotask(() => { void writeFile(environment.SITECAD_UPDATE_READY, 'ready'); });
    return child;
  } });
  await assert.rejects(prepared.install());
  await assert.rejects(stat(environment.SITECAD_UPDATE_ARMED), { code: 'ENOENT' });
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  await prepared.cleanup();
});

test('managed download cleanup is limited to the update cache and uses the same tested installer arguments', async t => {
  const options = await fixture(t, 'win32');
  const download = join(options.updatesDir, 'download-private');
  await mkdir(download);
  const file = join(download, 'SiteCAD-0.16.3-Windows-x64-Setup.exe');
  await writeFile(file, 'verified package fixture');
  let environment;
  const prepared = await prepareUpdateInstall({ ...options, file }, { spawnImpl: (_command, _args, settings) => {
    environment = settings.env;
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => {};
    child.exitCode = null;
    queueMicrotask(() => { void acknowledgeFakeHelper(environment); });
    return child;
  } });
  await prepared.install();
  assert.equal(environment.SITECAD_UPDATE_DOWNLOAD, file);
  assert.deepEqual(JSON.parse(environment.SITECAD_UPDATE_ARGUMENTS), windowsUpdateArguments(join(options.executable, '..')));
});

test('failed DMG detachment removes only staged replacement and leaves current app intact', async t => {
  const options = await fixture(t);
  const commands = fakeCommands(options, { fail: (command, args) => command.endsWith('/hdiutil') && args[0] === 'detach' });
  await assert.rejects(prepareUpdateInstall(options, commands));
  assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
  assert.ok(!(await readdir(join(options.executable, '../../../..'))).some(name => name.startsWith('.SiteCAD-update-')));
});

test('native helpers never kill the parent, alter OS trust, remove drawings or erase user settings', async () => {
  const mac = await readFile(new URL('../desktop/update-mac.sh', import.meta.url), 'utf8');
  const win = await readFile(new URL('../desktop/update-windows.ps1', import.meta.url), 'utf8');
  assert.match(mac, /kill -0/);
  assert.doesNotMatch(mac, /kill -(?:9|TERM)|xattr|spctl|rm -rf|defaults write/);
  assert.match(mac, /backup/);
  assert.match(mac, /restore|rollback/);
  assert.match(mac, /\/usr\/bin\/osascript/);
  assert.match(mac, /cleanup_download/);
  assert.doesNotMatch(win, /Stop-Process|taskkill|ExecutionPolicy|Remove-Item.*(?:drawings|APPDATA)/i);
  assert.match(win, /Wait|Start-Sleep/);
  assert.match(win, /MessageBox/);
  assert.match(win, /Remove-Download/);
  if (process.platform !== 'win32') execFileSync('/bin/sh', ['-n', new URL('../desktop/update-mac.sh', import.meta.url).pathname]);
});


test('helper startup errors retain bounded diagnostics only in cause and keep the user message generic', async t => {
  const options = await fixture(t, 'win32');
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  child.kill = () => {};
  const prepared = await prepareUpdateInstall(options, { spawnImpl: (_command, _args, settings) => {
    assert.equal(settings.stdio[2], 'pipe');
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('Windows helper parse failure ' + 'x'.repeat(10000)));
      child.exitCode = 1;
    });
    return child;
  } });
  await assert.rejects(prepared.install(), error => {
    assert.doesNotMatch(error.message, /parse failure/);
    assert.equal(error.cause.phase, 'helper-start');
    assert.equal(error.cause.exitCode, 1);
    assert.match(error.cause.stderr, /^Windows helper parse failure/);
    assert.ok(error.cause.stderr.length <= 4096);
    return true;
  });
  await prepared.cleanup();
});


test('real Windows helper survives the spawning Node parent exit and waits before touching the installer', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const options = await fixture(t, 'win32');
  const moduleUrl = new URL('../desktop/update-install.mjs', import.meta.url).href;
  const source = `import { prepareUpdateInstall } from ${JSON.stringify(moduleUrl)};
const prepared = await prepareUpdateInstall(JSON.parse(process.env.SITECAD_TEST_OPTIONS));
await prepared.install();`;
  let helperPid;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, SITECAD_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  runner.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 5000); });
  const findHelper = async () => {
    for (const name of await readdir(options.updatesDir)) {
      if (name.startsWith('install-')) {
        const text = await readFile(join(options.updatesDir, name, 'helper.pid'), 'utf8').catch(() => '');
        if (/^\d+$/.test(text)) return Number(text);
      }
    }
  };
  try {
    const code = await new Promise((resolve, reject) => { runner.once('error', reject); runner.once('exit', resolve); });
    helperPid = await findHelper();
    assert.equal(code, 0, diagnostics);
    assert.ok(Number.isInteger(helperPid) && helperPid > 1 && helperPid !== process.pid);
    await delay(1000);
    process.kill(helperPid, 0); // The real spawning Node process has exited; its helper must remain alive.
    assert.equal(await readFile(options.executable, 'utf8'), 'old executable');
    assert.equal(await readFile(options.file, 'utf8'), 'verified package fixture');
    await assert.rejects(stat(join(options.updatesDir, 'install-result.json')), { code: 'ENOENT' });
  } finally {
    helperPid ??= await findHelper();
    if (helperPid > 1 && helperPid !== process.pid && helperPid !== runner.pid) {
      try { process.kill(helperPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (runner.exitCode === null) runner.kill();
  }
});
