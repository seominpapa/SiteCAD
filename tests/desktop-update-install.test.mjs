import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
  assert.equal(copy.options.env?.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
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
    child.exitCode = null;
    queueMicrotask(() => { void writeFile(spawnOptions.env.SITECAD_UPDATE_READY, 'ready'); });
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
  assert.equal(launched.options.env.ACCESS_TOKEN, undefined);
  assert.equal(launched.options.env.OPENAI_API_KEY, undefined);
  assert.ok(!code.includes('ExecutionPolicy'));
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
    queueMicrotask(() => { void writeFile(environment.SITECAD_UPDATE_READY, 'ready'); });
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
