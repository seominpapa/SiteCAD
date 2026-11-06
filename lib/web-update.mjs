import { spawn, execFile } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopUpdater } from '../desktop/updater.mjs';
import { webUpdateEntries } from './web-update-helper.mjs';

const execute = promisify(execFile);
const failure = () => Error('웹앱 업데이트를 준비하지 못했습니다. 설치 폴더 권한을 확인해 주세요. 기존 도면과 설정은 유지합니다.');
export const isWithinWebPath = (root, location, pathApi = path) => { const value = pathApi.relative(root, location); return value === '' || value !== '..' && !value.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(value); };
const powershell = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;

export function checkedWebArchiveNames(names) {
  if (!Array.isArray(names) || !names.length || names.length > 10000) throw failure();
  const seen = new Set();
  for (const name of names) {
    const path = typeof name === 'string' ? name.replace(/\/$/, '') : '';
    const parts = path.split('/');
    if (!path || path.length > 2048 || /[\\:\x00-\x1f\x7f]/.test(path) || parts[0] !== 'SiteCAD' || parts.some(part => !part || part === '.' || part === '..') ||
      parts.length > 1 && ![...webUpdateEntries, 'drawings'].includes(parts[1]) || seen.has(path.toLowerCase())) throw failure();
    seen.add(path.toLowerCase());
  }
  return names;
}

async function checkedTree(root) {
  let count = 0, size = 0;
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory() || ++count > 10000 || (size += info.isFile() ? info.size : 0) > 2 * 1024 * 1024 * 1024) throw failure();
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(root);
}

async function extract(file, destination, platform, executeCommand) {
  const options = { timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  if (platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead(${literal(file)});try{$names=@();$size=0;foreach($entry in $zip.Entries){$name=$entry.FullName;$size+=$entry.Length;if($names.Count -ge 10000 -or $size -gt 2147483648 -or $name -match '[\\\\:\x00-\x1f]' -or $name -notmatch '^SiteCAD(?:/|$)' -or ($name.TrimEnd('/').Split('/') | Where-Object {$_ -eq '.' -or $_ -eq '..' -or $_ -eq ''}) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Invalid archive'};$names+=$name};[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);[Console]::Write(($names | ConvertTo-Json -Compress))}finally{$zip.Dispose()}`;
    const listing = await executeCommand(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
    checkedWebArchiveNames(JSON.parse(listing.stdout));
    const unpack = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory(${literal(file)},${literal(destination)})`;
    await executeCommand(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(unpack, 'utf16le').toString('base64')], options);
  } else {
    const listing = await executeCommand('/usr/bin/unzip', ['-Z', '-1', file], options);
    checkedWebArchiveNames(listing.stdout.trimEnd().split('\n'));
    const attributes = await executeCommand('/usr/bin/unzip', ['-Z', '-l', file], options);
    if (attributes.stdout.split('\n').some(line => /^l[rwx-]{9}\s/.test(line))) throw failure();
    const sizes = [...attributes.stdout.matchAll(/^[d-][rwxstST-]{9}\s+\S+\s+\S+\s+(\d+)\s/gm)].map(match => Number(match[1]));
    if (!sizes.length || sizes.reduce((sum, size) => sum + size, 0) > 2 * 1024 * 1024 * 1024) throw failure();
    await executeCommand('/usr/bin/ditto', ['-x', '-k', file, destination], options);
  }
  await checkedTree(destination);
}

export async function prepareWebUpdate({ file, version, target, updatesDir, platform = process.platform, parentPid = process.pid },
  { executeCommand = execute, spawnImpl = spawn, readyTimeoutMs = 15000 } = {}) {
  if (!['darwin', 'win32'].includes(platform) || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !Number.isSafeInteger(parentPid) || parentPid <= 1) throw failure();
  target = resolve(target); updatesDir = resolve(updatesDir); file = resolve(file);
  if (await realpath(target) !== target || await lstat(join(target, '.git')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw failure();
  await access(target, constants.W_OK | constants.X_OK);
  await mkdir(updatesDir, { recursive: true, mode: 0o700 });
  const job = await mkdtemp(join(updatesDir, 'web-install-'));
  // Staging and backups share the application's volume so rename remains atomic.
  const stage = await mkdtemp(join(target, '.sitecad-update-'));
  const extracted = join(stage, 'extracted'), staged = join(extracted, 'SiteCAD'), ready = join(job, 'ready'), jobPath = join(job, 'job.json');
  const helper = join(job, 'helper.mjs'), result = join(updatesDir, 'web-update-result.json');
  try {
    await extract(file, extracted, platform, executeCommand);
    const marker = JSON.parse(await readFile(join(staged, '.sitecad-web-release.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
    if (marker.type !== 'sitecad-local-web' || marker.platform !== platform || marker.version !== version || manifest.name !== 'sitecad-local' || manifest.version !== version) throw failure();
    for (const name of webUpdateEntries) await lstat(join(staged, name));
    if (platform === 'darwin') for (const name of ['Start SiteCAD.command', 'scripts/bootstrap-local-web.sh']) await chmod(join(staged, name), 0o755);
    await copyFile(new URL('./web-update-helper.mjs', import.meta.url), helper);
    await writeFile(jobPath, JSON.stringify({ parentPid, target, staged, backup: join(stage, 'previous'), version, platform, ready, result }), { flag: 'wx', mode: 0o600 });
    return {
      cleanup: () => Promise.all([rm(job, { recursive: true, force: true }), rm(stage, { recursive: true, force: true })]),
      async install() {
        const child = spawnImpl(process.execPath, [helper, jobPath], { cwd: job, detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
        let failed = false; child.once('error', () => { failed = true; });
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
          if (failed || child.exitCode != null) break;
          if (await readFile(ready, 'utf8').then(value => value === 'ready').catch(() => false)) { child.unref(); return; }
          await delay(20);
        }
        child.kill(); throw failure();
      },
    };
  } catch (error) { await Promise.all([rm(job, { recursive: true, force: true }), rm(stage, { recursive: true, force: true })]); throw error; }
}

export async function createWebUpdater({ appRoot, dataDir, currentVersion, drawingDirectory, onInstall, isClosing = () => false, isBusy = () => false, fetchImpl = fetch, prepareInstall }) {
  const supported = await readFile(join(appRoot, '.sitecad-web-release.json'), 'utf8').then(value => JSON.parse(value).type === 'sitecad-local-web').catch(() => false) &&
    !await lstat(join(appRoot, '.git')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
  const previous = await readFile(join(dataDir, 'updates/web-update-result.json'), 'utf8').then(JSON.parse).catch(() => null);
  let lastInstallFailed = previous?.status === 'failed' && ['apply', 'restart'].includes(previous.code);
  let scheduled = false, confirmation;
  const updater = createDesktopUpdater({ currentVersion, platform: process.platform, arch: process.arch, kind: 'web', updatesDir: join(dataDir, 'updates'), fetchImpl,
    showMessage: async message => {
      if (message.type !== 'warning') return { response: 1 };
      return new Promise(resolve => { confirmation = resolve; });
    }, isClosing,
    canInstall: async () => {
      if (await isBusy()) return false;
      const location = await drawingDirectory();
      const [root, drawings, profile] = await Promise.all([realpath(appRoot), realpath(location), realpath(dataDir)]);
      if (webUpdateEntries.some(name => isWithinWebPath(join(root, name), drawings) || isWithinWebPath(join(root, name), profile))) throw failure();
      return true;
    },
    prepareInstall: prepareInstall ?? (({ file, version }) => prepareWebUpdate({ file, version, target: appRoot, updatesDir: join(dataDir, 'updates') })),
    install: async prepared => { await prepared.install(); await onInstall(); },
  });
  const status = () => ({ ...updater.status(), supported, lastInstallFailed, ...(confirmation ? { busy: false, status: 'ready' } : scheduled ? { busy: true, status: 'scheduled' } : {}) });
  return { status, cancel: () => { const approve = confirmation; confirmation = undefined; approve?.({ response: 0 }); return updater.cancel(); },
    async check() { if (!supported) return status(); await updater.check({ notify: false }); return status(); },
    async install() {
      if (confirmation) {
        if (isClosing() || await isBusy()) throw failure();
        const approve = confirmation; confirmation = undefined; approve({ response: 1 }); return status();
      }
      if (!supported || scheduled || updater.status().busy || !updater.status().availableVersion || isClosing() || await isBusy()) throw failure();
      lastInstallFailed = false;
      scheduled = true;
      const timer = setTimeout(() => { scheduled = false; void updater.check({ manual: true }); }, 100); timer.unref?.();
      return status();
    },
  };
}
