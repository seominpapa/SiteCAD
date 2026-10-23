import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function launcherOptions(value) {
  if (!value || !isAbsolute(value.command ?? '') || !isAbsolute(value.cwd ?? '') || !Array.isArray(value.args ?? []) || (value.args ?? []).length > 64 || (value.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 8192) || typeof (value.env ?? {}) !== 'object' || Array.isArray(value.env)) throw Error('Invalid MCP launch configuration');
  const supplied = value.env ?? {};
  if (Object.keys(supplied).length > 64 || Object.entries(supplied).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(ACCESS_TOKEN$|CODEX_|SITECAD_)/.test(key) || typeof item !== 'string' || item.length > 65536)) throw Error('Invalid MCP environment');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', ...supplied, HOME: value.cwd };
  if (value.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  return { cwd: value.cwd, env, shell: false, stdio: ['inherit', 'inherit', 'inherit'] };
}

export function launchMcp(key, source = process.env) {
  if (typeof key !== 'string' || !/^SITECAD_MCP_LAUNCH_[A-Z0-9_]{1,64}$/.test(key) || typeof source[key] !== 'string' || source[key].length > 512 * 1024) throw Error('Invalid MCP launcher environment');
  const value = JSON.parse(source[key]);
  const child = spawn(value.command, value.args ?? [], launcherOptions(value));
  child.on('error', () => { process.stderr.write('External MCP could not start.\n'); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = Number.isInteger(code) ? code : 1; });
  const stop = signal => { child.kill(signal); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { launchMcp(process.argv[2]); }
  catch { process.stderr.write('External MCP launch configuration is invalid.\n'); process.exitCode = 1; }
}
