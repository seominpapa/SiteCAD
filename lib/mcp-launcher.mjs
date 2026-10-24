import { spawn } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isolatedProcessEnv(home, executable, { platform = process.platform, source = process.env } = {}) {
  if (platform !== 'win32') return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: home, ...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}) };
  const systemRoot = source.SystemRoot || source.SYSTEMROOT || source.WINDIR || 'C:\\Windows';
  return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: [win32.dirname(executable), win32.join(systemRoot, 'System32'), systemRoot].join(';'),
    LANG: 'en_US.UTF-8', HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home };
}

export function stopProcessTree(child, signal, { platform = process.platform, source = process.env, spawnImpl = spawn, killGroup = false } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    if (platform === 'win32') {
      // Windows child.kill stops only the parent, leaving its MCP processes alive.
      const root = source.SystemRoot || source.SYSTEMROOT || source.WINDIR || 'C:\\Windows';
      const killer = spawnImpl(win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env: { SystemRoot: root, WINDIR: root }, shell: false, windowsHide: true, stdio: 'ignore' });
      let failed = false;
      const fallback = () => { if (!failed) { failed = true; child.kill(signal); } };
      killer.once('error', fallback); killer.once('close', code => { if (code !== 0) fallback(); });
      return;
    }
    if (killGroup) {
      try { process.kill(-child.pid, signal); return; } catch { /* The process may already have exited. */ }
    }
  }
  child.kill(signal);
}

export function launcherOptions(value) {
  if (!value || !isAbsolute(value.command ?? '') || !isAbsolute(value.cwd ?? '') || !Array.isArray(value.args ?? []) || (value.args ?? []).length > 64 || (value.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 8192) || typeof (value.env ?? {}) !== 'object' || Array.isArray(value.env)) throw Error('Invalid MCP launch configuration');
  const supplied = value.env ?? {};
  if (Object.keys(supplied).length > 64 || Object.entries(supplied).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(ACCESS_TOKEN$|CODEX_|SITECAD_)/.test(key) || typeof item !== 'string' || item.length > 65536)) throw Error('Invalid MCP environment');
  const privateEnv = isolatedProcessEnv(value.cwd, value.command);
  const env = { ...privateEnv, ...supplied, HOME: value.cwd, ...(process.platform === 'win32' ? { USERPROFILE: value.cwd, APPDATA: value.cwd, LOCALAPPDATA: value.cwd } : {}) };
  if (value.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  return { cwd: value.cwd, env, shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit'] };
}

export function launchMcp(key, source = process.env) {
  if (typeof key !== 'string' || !/^SITECAD_MCP_LAUNCH_[A-Z0-9_]{1,64}$/.test(key) || typeof source[key] !== 'string' || source[key].length > 512 * 1024) throw Error('Invalid MCP launcher environment');
  const value = JSON.parse(source[key]);
  const child = spawn(value.command, value.args ?? [], launcherOptions(value));
  child.on('error', () => { process.stderr.write('External MCP could not start.\n'); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = Number.isInteger(code) ? code : 1; });
  const stop = signal => { stopProcessTree(child, signal); setTimeout(() => stopProcessTree(child, 'SIGKILL'), 2000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { launchMcp(process.argv[2]); }
  catch { process.stderr.write('External MCP launch configuration is invalid.\n'); process.exitCode = 1; }
}
