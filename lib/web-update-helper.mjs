import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const webUpdateEntries = Object.freeze(['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SOURCE_BUILD.md', 'Start SiteCAD.command', 'Start SiteCAD.cmd', 'server.mjs', 'local-web.mjs', 'lib', 'public', 'skills', 'plan.schema.json', 'codex-models.json', 'desktop', 'vendor', 'scripts', 'fixtures', '.sitecad-web-release.json']);
const failure = () => Error('웹앱 업데이트를 적용하지 못했습니다. 기존 앱과 도면·설정은 보존합니다.');
const exists = async path => lstat(path).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });

export async function applyWebUpdate({ target, staged, backup, version }, { move = rename } = {}) {
  if (![target, staged, backup].every(path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path) ||
    !/^\d+\.\d+\.\d+$/.test(version ?? '') || target === staged || target === backup || staged === backup) throw failure();
  for (const path of [target, staged]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure();
  }
  if (await exists(join(target, '.git')) || await exists(backup)) throw failure();
  const marker = JSON.parse(await readFile(join(staged, '.sitecad-web-release.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
  if (marker.type !== 'sitecad-local-web' || marker.version !== version || manifest.name !== 'sitecad-local' || manifest.version !== version) throw failure();
  const replaced = [], installed = [];
  await mkdir(backup, { mode: 0o700 });
  try {
    for (const name of webUpdateEntries) {
      if (!await exists(join(staged, name))) throw failure();
      if (await exists(join(target, name))) { await move(join(target, name), join(backup, name)); replaced.push(name); }
      await move(join(staged, name), join(target, name)); installed.push(name);
    }
  } catch {
    let restored = true;
    for (const name of installed.toReversed()) { try { await move(join(target, name), join(staged, name)); } catch { restored = false; } }
    for (const name of replaced.toReversed()) { try { await move(join(backup, name), join(target, name)); } catch { restored = false; } }
    if (!restored) throw Error('웹앱 복구를 마치지 못했습니다. 업데이트 백업 폴더를 보관하고 지원을 요청해 주세요. 도면·사용자 설정 폴더는 변경하지 않았습니다.');
    throw failure();
  }
  return { status: 'installed', version };
}

export function restartWeb(target, platform = process.platform, spawnImpl = spawn) {
  const command = platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/usr/bin/open';
  const args = platform === 'win32' ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(target, 'scripts/bootstrap-local-web.ps1')] : [join(target, 'Start SiteCAD.command')];
  const child = spawnImpl(command, args, { cwd: target, detached: true, windowsHide: false, stdio: 'ignore' });
  return new Promise((resolveLaunch, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

const parentRunning = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

export async function runWebUpdate(jobPath, { restart = restartWeb, running = parentRunning, wait = delay } = {}) {
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  if (!Number.isSafeInteger(job.parentPid) || job.parentPid <= 1 || !['win32', 'darwin'].includes(job.platform) ||
    job.result !== join(dirname(dirname(jobPath)), 'web-update-result.json') || dirname(job.ready) !== dirname(jobPath)) throw failure();
  await writeFile(job.ready, 'ready', { flag: 'wx', mode: 0o600 });
  let stopped = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!running(job.parentPid)) { stopped = true; break; }
    await wait(1000);
  }
  if (!stopped) throw failure();
  try {
    const result = await applyWebUpdate(job);
    await writeFile(job.result, JSON.stringify(result), { mode: 0o600 });
  } catch {
    await writeFile(job.result, JSON.stringify({ status: 'failed', code: 'apply', version: job.version }), { mode: 0o600 });
  }
  try { await restart(job.target, job.platform); }
  catch (error) {
    await writeFile(job.result, JSON.stringify({ status: 'failed', code: 'restart', version: job.version }), { mode: 0o600 });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWebUpdate(process.argv[2]).catch(() => { process.exitCode = 1; });
}
