import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, chmod } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const failure = () => Error('업데이트를 준비하지 못했습니다. 앱을 설치한 폴더의 쓰기 권한과 설치 파일을 확인해 주세요. 기존 도면과 설정은 변경하지 않았습니다.');
function checkedPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw failure();
  return resolve(path);
}

export function windowsUpdateArguments(destination) {
  if (typeof destination !== 'string' || !win32.isAbsolute(destination) || /["\x00-\x1f\x7f]/.test(destination)) throw failure();
  return ['/SILENT', '/SP-', '/NORESTART', '/NOCLOSEAPPLICATIONS', '/NOFORCECLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', `/DIR="${destination}"`];
}

function helperEnvironment(values) {
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
  const environment = Object.fromEntries(keys.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR || 'C:\\Windows';
  return { ...environment, PATH: process.platform === 'win32' ? `${systemRoot}\\System32;${systemRoot}` : '/usr/bin:/bin:/usr/sbin:/sbin', ...values };
}

async function startHelper({ command, args, environment, readyFile, cwd, spawnImpl, readyTimeoutMs }) {
  const child = spawnImpl(command, args, { cwd, env: helperEnvironment(environment), detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError, stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 4096); });
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + readyTimeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode != null) throw failure();
      if (await readFile(readyFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) === 'ready') {
        child.stderr?.unref?.();
        child.unref();
        return;
      }
      await delay(10);
    }
    throw failure();
  } catch (error) {
    child.kill();
    const wrapped = failure();
    wrapped.cause = { phase: 'helper-start', exitCode: child.exitCode, signal: child.signalCode ?? null, spawnCode: spawnError?.code ?? null, stderr };
    throw wrapped;
  }
}

async function checkAppLocalDrawings(appPath) {
  for (const directory of [join(appPath, 'drawings'), join(appPath, 'Contents/Resources/app/drawings')]) {
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (names.some(name => !['Test', '.DS_Store'].includes(name))) throw Error('앱 내부에 사용자 도면이 있습니다. 도면을 앱 밖의 저장 폴더로 옮긴 뒤 다시 업데이트해 주세요.');
  }
}

async function stageMac({ file, executable, job, version, executeCommand }) {
  const target = dirname(dirname(dirname(executable)));
  if (target.includes('/AppTranslocation/')) throw Error('임시 보안 실행 위치에서는 업데이트할 수 없습니다. SiteCAD.app을 응용 프로그램 폴더로 옮긴 뒤 다시 실행해 주세요.');
  if (basename(executable) !== 'SiteCAD' || basename(target) !== 'SiteCAD.app' || executable !== join(target, 'Contents/MacOS/SiteCAD')) throw failure();
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw failure();
  await checkAppLocalDrawings(target);
  await access(dirname(target), constants.W_OK | constants.X_OK);
  const staging = await mkdtemp(join(dirname(target), '.SiteCAD-update-'));
  await chmod(staging, 0o700);
  const mount = join(job, 'mount'), staged = join(staging, 'SiteCAD.app');
  const env = helperEnvironment({});
  await mkdir(mount, { mode: 0o700 });
  let mounted = false;
  try {
    await executeCommand('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file], { timeout: 120000, maxBuffer: 16384, env });
    mounted = true;
    const source = join(mount, 'SiteCAD.app');
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw failure();
    await executeCommand('/usr/bin/ditto', [source, staged], { timeout: 180000, maxBuffer: 16384, env });
    const plist = join(staged, 'Contents/Info.plist');
    for (const [key, expected] of [['CFBundleIdentifier', 'com.sitecad.desktop'], ['CFBundleShortVersionString', version], ['CFBundleExecutable', 'SiteCAD']]) {
      const { stdout } = await executeCommand('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { timeout: 10000, maxBuffer: 1024, env });
      if (stdout.trim() !== expected) throw failure();
    }
    const stagedExecutable = join(staged, 'Contents/MacOS/SiteCAD');
    const { stdout } = await executeCommand('/usr/bin/lipo', ['-archs', stagedExecutable], { timeout: 10000, maxBuffer: 1024, env });
    if (!stdout.trim().split(/\s+/).includes('arm64')) throw failure();
    await executeCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], { timeout: 120000, maxBuffer: 16384, env });
    return { target, staged, staging, backup: join(dirname(target), `.SiteCAD-previous-${randomUUID()}.app`) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (mounted) {
      try { await executeCommand('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000, maxBuffer: 16384, env }); }
      catch {
        await rm(staging, { recursive: true, force: true });
        const error = failure();
        error.code = 'SITECAD_UPDATE_MOUNTED';
        throw error;
      }
    }
  }
}

export async function prepareUpdateInstall({ file, version, executable, updatesDir, platform = process.platform, arch = process.arch, parentPid = process.pid },
  { executeCommand = execute, spawnImpl = spawn, readyTimeoutMs = 5000 } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !Number.isSafeInteger(parentPid) || parentPid <= 0 ||
    !(platform === 'darwin' && arch === 'arm64' || platform === 'win32' && arch === 'x64')) throw failure();
  file = checkedPath(file); executable = checkedPath(executable); updatesDir = checkedPath(updatesDir);
  const expected = `SiteCAD-${version}-${platform === 'darwin' ? 'macOS-arm64.dmg' : 'Windows-x64-Setup.exe'}`;
  const info = await lstat(file);
  if (basename(file) !== expected || !info.isFile() || info.isSymbolicLink()) throw failure();
  const directoryInfo = await lstat(updatesDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw failure();
  const downloadDirectory = dirname(file);
  const managedDownload = dirname(downloadDirectory) === updatesDir && /^download-[A-Za-z0-9_-]+$/.test(basename(downloadDirectory)) &&
    !(await lstat(downloadDirectory)).isSymbolicLink() && await realpath(downloadDirectory) === downloadDirectory ? file : '';
  if (platform === 'win32' && (basename(executable).toLowerCase() !== 'sitecad.exe' || /"/.test(executable))) throw failure();
  const installed = await lstat(executable);
  if (!installed.isFile() || installed.isSymbolicLink()) throw failure();
  const job = await mkdtemp(join(updatesDir, 'install-'));
  await chmod(job, 0o700);
  const resultFile = join(updatesDir, 'install-result.json'), readyFile = join(job, 'ready');
  let mac, armed = false, canceled = false;
  try {
    if (platform === 'darwin') mac = await stageMac({ file, version, executable, job, executeCommand });
    const helper = join(job, platform === 'darwin' ? 'update-mac.sh' : 'update-windows.ps1');
    await copyFile(new URL(platform === 'darwin' ? './update-mac.sh' : './update-windows.ps1', import.meta.url), helper);
    await chmod(helper, 0o700);
    return {
      resultFile,
      async install() {
        if (canceled) throw Error('업데이트 설치가 취소되었습니다.');
        if (armed) return;
        let command, args, environment = {};
        if (platform === 'darwin') {
          command = '/bin/sh';
          args = [helper, String(parentPid), mac.target, mac.staged, mac.backup, resultFile, version, readyFile, managedDownload];
        } else {
          const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
          command = win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
          args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(await readFile(helper, 'utf8'), 'utf16le').toString('base64')];
          environment = { SITECAD_UPDATE_PARENT: String(parentPid), SITECAD_UPDATE_INSTALLER: file, SITECAD_UPDATE_DESTINATION: dirname(executable),
            SITECAD_UPDATE_RESULT: resultFile, SITECAD_UPDATE_VERSION: version, SITECAD_UPDATE_READY: readyFile, SITECAD_UPDATE_DOWNLOAD: managedDownload,
            SITECAD_UPDATE_ARGUMENTS: JSON.stringify(windowsUpdateArguments(dirname(executable))) };
        }
        await startHelper({ command, args, environment, readyFile, cwd: job, spawnImpl, readyTimeoutMs });
        armed = true;
      },
      async cleanup() {
        if (armed) return;
        canceled = true;
        if (mac) await rm(mac.staging, { recursive: true, force: true });
        await rm(job, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (mac) await rm(mac.staging, { recursive: true, force: true });
    if (error.code !== 'SITECAD_UPDATE_MOUNTED') await rm(job, { recursive: true, force: true });
    throw error;
  }
}
