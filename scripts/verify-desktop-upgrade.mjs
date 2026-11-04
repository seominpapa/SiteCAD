import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stopProcessTree } from '../lib/mcp-launcher.mjs';
import { sanitizeDiagnostic, verifyDesktop } from './verify-desktop.mjs';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const previousVersion = '0.16.2';

export function requireHostedUpgrade(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || !isAbsolute(env.RUNNER_TEMP ?? '')) throw Error('Desktop upgrade verification requires a clean hosted CI machine.');
  if (!(platform === 'darwin' && arch === 'arm64' || platform === 'win32' && arch === 'x64')) throw Error('Desktop upgrade verification requires a supported platform.');
}

export function upgradePaths(directory, platform = process.platform) {
  assert.ok(isAbsolute(directory), 'Upgrade directory must be absolute');
  assert.ok(['darwin', 'win32'].includes(platform), 'Upgrade platform must be supported');
  const installation = join(directory, '설치 확인 SiteCAD');
  return { installation, drawings: join(installation, 'drawings'),
    executable: join(installation, platform === 'darwin' ? 'SiteCAD.app/Contents/MacOS/SiteCAD' : 'SiteCAD.exe'),
    appRoot: join(installation, platform === 'darwin' ? 'SiteCAD.app/Contents/Resources/app' : 'resources/app') };
}

export async function fileFingerprints(files) {
  return Promise.all(files.map(async file => {
    const bytes = await readFile(file);
    return { name: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

export async function verifyFileFingerprints(files, expected) {
  assert.deepEqual(await fileFingerprints(files), expected, 'Existing drawings or settings changed during the upgrade');
}

export function upgradeErrorDetails(error) {
  const text = (value, limit = 128) => typeof value === 'string' ? sanitizeDiagnostic(value).slice(-limit) : undefined;
  const cause = error.cause && typeof error.cause === 'object' ? {
    phase: text(error.cause.phase), exitCode: Number.isSafeInteger(error.cause.exitCode) ? error.cause.exitCode : null,
    signal: text(error.cause.signal) ?? null, spawnCode: text(error.cause.spawnCode) ?? null,
    stderr: text(error.cause.stderr, 4096), stdout: text(error.cause.stdout, 4096),
    bootstrapPhase: ['bootstrap-start', 'helper-started', 'pid-written'].includes(error.cause.bootstrapPhase) ? error.cause.bootstrapPhase : undefined,
    hasPid: typeof error.cause.hasPid === 'boolean' ? error.cause.hasPid : undefined,
    hasReady: typeof error.cause.hasReady === 'boolean' ? error.cause.hasReady : undefined,
  } : undefined;
  return { error: text(error.message, 4096), code: text(error.code), cause };
}

async function until(action, label, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await delay(250);
  }
  throw Error(`Desktop upgrade verification timed out: ${label}`);
}

function macDesktopProcesses(stdout) {
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match && Number(match[1]) > 0 && basename(match[2]) === 'SiteCAD' ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

export async function matchingMacDesktopProcesses(stdout, executable, canonicalize = realpath) {
  const expected = (await canonicalize(executable)).normalize('NFC');
  const matches = await Promise.all(macDesktopProcesses(stdout).map(async process => {
    try { return (await canonicalize(process.executable)).normalize('NFC') === expected ? process : undefined; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
  }));
  return matches.filter(Boolean);
}

async function macProcessSnapshot() {
  // Unlimited output width and realpath comparison handle LaunchServices path aliases and decomposed Unicode.
  const { stdout } = await execute('/bin/ps', ['-ww', '-axo', 'pid=,comm='], { timeout: 10000 });
  return stdout;
}

async function runningDesktop(executable) {
  if (process.platform === 'darwin') {
    return (await matchingMacDesktopProcesses(await macProcessSnapshot(), executable)).map(process => process.pid);
  }
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:SITECAD_VERIFY_EXECUTABLE } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress';
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, SITECAD_VERIFY_EXECUTABLE: executable }, timeout: 20000, windowsHide: true,
  });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(value) ? value : [value];
}

async function stopRelaunchedDesktop(executable) {
  const ids = await until(async () => {
    const ids = await runningDesktop(executable);
    return ids.length ? ids : undefined;
  }, 'updated app relaunch', 30000);
  for (const pid of ids) stopProcessTree({ pid, exitCode: null, signalCode: null, kill(signal) {
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  } }, 'SIGKILL');
  await until(async () => (await runningDesktop(executable)).length === 0, 'stop test relaunch', 30000);
  return ids;
}

async function installPrevious(file, paths, directory) {
  await mkdir(paths.installation, { recursive: true });
  if (process.platform === 'win32') {
    await execute(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${paths.installation}`], { timeout: 180000, windowsHide: true });
    return;
  }
  const mount = join(directory, 'previous-mount');
  await mkdir(mount);
  await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file], { timeout: 120000 });
  try { await execute('/usr/bin/ditto', [join(mount, 'SiteCAD.app'), join(paths.installation, 'SiteCAD.app')], { timeout: 180000 }); }
  finally { await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 }); }
}

async function finishTestParent(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 'test editor exit', 5000); }
  catch (error) { child.kill('SIGKILL'); throw error; }
}

export async function verifyDesktopUpgrade() {
  requireHostedUpgrade();
  const { updateFromRelease, downloadUpdate } = await import('../desktop/updater.mjs');
  const { prepareUpdateInstall } = await import('../desktop/update-install.mjs');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.notEqual(version, previousVersion, 'Upgrade CI must build a newer version than the public baseline');
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'sitecad-upgrade-'));
  const paths = upgradePaths(directory);
  const output = join(root, 'dist/verification/desktop-upgrade');
  await mkdir(output, { recursive: true });
  const profile = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/SiteCAD') : join(process.env.APPDATA, 'SiteCAD');
  const setting = join(profile, 'drawing-storage.json');
  const originalSetting = await readFile(setting).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const secret = join(profile, `upgrade-credential-${basename(directory)}.enc`);
  let parent, prepared, result, stage = 'previous public installer';
  try {
    const response = await fetch(`https://api.github.com/repos/seominpapa/SiteCAD/releases/tags/v${previousVersion}`, {
      headers: { 'User-Agent': 'SiteCAD-native-upgrade-verification' }, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Previous public installer metadata must be available');
    const release = await response.json();
    assert.equal(release.tag_name, `v${previousVersion}`);
    const previous = updateFromRelease(release, { currentVersion: '0.0.0', platform: process.platform, arch: process.arch });
    assert.ok(previous);
    const previousFile = await downloadUpdate(previous, { directory });
    await installPrevious(previousFile, paths, directory);
    const installedVersion = async () => JSON.parse(await readFile(join(paths.appRoot, 'package.json'), 'utf8')).version;
    assert.equal(await installedVersion(), previousVersion);
    await mkdir(paths.drawings, { recursive: true });
    await mkdir(profile, { recursive: true });
    const drawing = join(paths.drawings, '기존 도면.dwg');
    await writeFile(drawing, await readFile(join(root, 'fixtures/retaining-wall.dwg')));
    await writeFile(`${drawing}.sitecad.json`, JSON.stringify({ upgradeTest: 'sidecar bytes must survive' }));
    await writeFile(setting, JSON.stringify({ version: 1, path: paths.drawings }));
    // Opaque bytes in an unused file prove preservation without impersonating an authenticated account.
    await writeFile(secret, Buffer.from([83, 67, 0, 255, 41, 19]), { flag: 'wx', mode: 0o600 });
    const preservedFiles = [drawing, `${drawing}.sitecad.json`, setting, secret];
    const before = await fileFingerprints(preservedFiles);
    parent = spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ['pipe', 'ignore', 'ignore'] });
    await once(parent, 'spawn');
    const installer = join(root, 'dist', `SiteCAD-${version}-${process.platform === 'darwin' ? 'macOS-arm64.dmg' : 'Windows-x64-Setup.exe'}`);
    assert.ok((await stat(installer)).isFile());
    const updatesDir = join(directory, 'updates');
    await mkdir(updatesDir);
    prepared = await prepareUpdateInstall({ file: installer, version, executable: paths.executable, updatesDir, parentPid: parent.pid });
    stage = 'native installer handoff';
    await prepared.install();
    await delay(500);
    assert.equal(parent.exitCode, null, 'Updater must not terminate the running editor');
    assert.equal(await installedVersion(), previousVersion, 'Installer must wait for editor exit');
    await finishTestParent(parent);
    result = await until(async () => {
      const text = await readFile(prepared.resultFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : undefined;
    }, 'native installer result');
    assert.equal(result.status, 'installed', `Native installer failed: ${result.code}`);
    assert.equal(result.version, version);
    assert.equal(await installedVersion(), version, 'Installed payload must be the new build');
    await verifyFileFingerprints(preservedFiles, before);
    stage = 'updated app relaunch';
    const helperRelaunchPids = await stopRelaunchedDesktop(paths.executable);
    stage = 'updated app renderer readiness';
    const desktop = await verifyDesktop({ executable: paths.executable, outputDirectory: join(output, 'desktop-ready') });
    await verifyFileFingerprints(preservedFiles, before);
    const proof = { previousVersion, version, platform: process.platform, arch: process.arch, previousInstaller: previous,
      parentExitRequired: true, installedAtSamePath: true, drawingsAndSettingsPreserved: true, preservedFiles: before,
      helperRelaunchObserved: true, helperRelaunchPids, result, desktop,
      limitations: ['No real-account credentials or external AI inference; opaque sentinel preservation does not prove Keychain approval or decryption.',
        'The adapter is exercised after a controlled test process exits; native consent dialogs are covered separately by coordinator tests.',
        'The test stops the helper-launched empty app before checking renderer readiness in a new instrumented launch.',
        'Browser-origin Gatekeeper or SmartScreen approval is not reproduced by programmatic CI downloads.'] };
    await writeFile(join(output, 'desktop-upgrade.json'), `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`Desktop upgrade ${previousVersion} -> ${version} verified on ${process.platform}/${process.arch}: existing drawings and settings preserved.`);
    return proof;
  } catch (error) {
    const processes = process.platform === 'darwin' ? await macProcessSnapshot().then(macDesktopProcesses).catch(snapshotError => ({ error: snapshotError.message })) : undefined;
    const diagnostic = sanitizeDiagnostic(JSON.stringify({ stage, ...upgradeErrorDetails(error), expectedExecutable: paths.executable, result, processes }, null, 2));
    await writeFile(join(output, 'desktop-upgrade-failure.json'), `${diagnostic}\n`).catch(() => console.error('Could not save desktop upgrade diagnostic'));
    console.error(diagnostic);
    throw error;
  } finally {
    await finishTestParent(parent);
    await prepared?.cleanup();
    if (originalSetting === null) await rm(setting, { force: true }); else await writeFile(setting, originalSetting);
    await rm(secret, { force: true });
  }
}

if (import.meta.main) await verifyDesktopUpgrade();
