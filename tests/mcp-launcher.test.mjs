import test from 'node:test';
import assert from 'node:assert/strict';
import { launcherOptions, isolatedProcessEnv, stopProcessTree } from '../lib/mcp-launcher.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

test('Windows child environment has OS paths and an isolated profile without parent credentials', () => {
  const env = isolatedProcessEnv('C:\\SiteCAD Data\\workspace', 'C:\\SiteCAD\\node.exe', { platform: 'win32', source: { SystemRoot: 'D:\\Windows', PATH: 'C:\\User Tools', USERPROFILE: 'C:\\Users\\Owner', ACCESS_TOKEN: 'secret', SITECAD_MCP_TOKEN_OTHER: 'secret' } });
  assert.equal(env.SystemRoot, 'D:\\Windows');
  assert.equal(env.PATH, 'C:\\SiteCAD;D:\\Windows\\System32;D:\\Windows');
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.equal(env[key], 'C:\\SiteCAD Data\\workspace');
  assert.equal(env.ACCESS_TOKEN, undefined);
  assert.equal(env.SITECAD_MCP_TOKEN_OTHER, undefined);
});

test('Windows shutdown kills only the owned positive PID tree and falls back when taskkill fails', () => {
  const calls = []; const child = { pid: 4567, kill: signal => calls.push(['fallback', signal]) }; let killer;
  const spawnImpl = (command, args, options) => { calls.push([command, args, options]); killer = new EventEmitter(); return killer; };
  stopProcessTree(child, 'SIGTERM', { platform: 'win32', source: { SystemRoot: 'C:\\Windows' }, spawnImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls[0][1], ['/PID', '4567', '/T', '/F']);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
  killer.emit('close', 0); assert.equal(calls.length, 1);
  stopProcessTree(child, 'SIGKILL', { platform: 'win32', spawnImpl });
  killer.emit('error', Error('unavailable')); killer.emit('close', -1);
  assert.deepEqual(calls.at(-1), ['fallback', 'SIGKILL']);
  assert.equal(calls.filter(call => call[0] === 'fallback').length, 1);
  stopProcessTree({ pid: -1, kill: signal => calls.push(['invalid-pid', signal]) }, 'SIGTERM', { platform: 'win32', spawnImpl });
  assert.deepEqual(calls.at(-1), ['invalid-pid', 'SIGTERM']);
});

test('Windows native shutdown removes the MCP child and its grandchild', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    grandchild.once('spawn', () => process.stdout.write(JSON.stringify({ pid: grandchild.pid }) + '\\n'));
    setInterval(() => {}, 1000);
  `], { env: isolatedProcessEnv(tmpdir(), process.execPath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let grandchildPid;
  try {
    const ready = new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('MCP fixture did not start')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output).pid); } });
    });
    grandchildPid = await ready;
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    process.kill(grandchildPid, 0);
    const exited = new Promise(resolve => child.once('close', resolve));
    stopProcessTree(child, 'SIGTERM');
    await exited;
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(grandchildPid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'MCP grandchild must not survive runtime shutdown');
  } finally {
    stopProcessTree(child, 'SIGKILL');
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
});

test('external MCP receives only its own credentials and private workspace', () => {
  const result = launcherOptions({ command: '/app/python', args: ['server.py'], env: { API_KEY: 'own-key' }, cwd: '/private/app/workspace' }, { ACCESS_TOKEN: 'oauth-secret', SITECAD_BRIDGE_TOKEN: 'bridge-secret', SITECAD_MCP_LAUNCH_OTHER: 'other-key', HOME: '/Users/private' });
  assert.equal(result.env.API_KEY, 'own-key');
  assert.equal(result.env.ACCESS_TOKEN, undefined);
  assert.equal(result.env.SITECAD_BRIDGE_TOKEN, undefined);
  assert.equal(result.env.SITECAD_MCP_LAUNCH_OTHER, undefined);
  assert.equal(result.env.HOME, '/private/app/workspace');
  assert.equal(launcherOptions({ command: '/app/python', cwd: '/private/app/workspace', env: { HOME: '/Users/private' } }).env.HOME, '/private/app/workspace');
  assert.equal(result.shell, false);
  assert.deepEqual(result.stdio, ['inherit', 'inherit', 'inherit']);
});
test('launcher starts a real stdio process without forwarding parent or sibling credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-launcher-test-'));
  try {
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(fixture, 'process.stdout.write(JSON.stringify({cwd:process.cwd(),env:process.env}));');
    const key = 'SITECAD_MCP_LAUNCH_REFERENCE';
    const child = spawn(process.execPath, [fileURLToPath(new URL('../lib/mcp-launcher.mjs', import.meta.url)), key], { env: { ACCESS_TOKEN: 'private-oauth', SITECAD_BRIDGE_TOKEN: 'private-bridge', SITECAD_MCP_LAUNCH_OTHER: 'sibling-secret', [key]: JSON.stringify({ command: process.execPath, args: [fixture], cwd: directory, env: { REF_KEY: 'own-reference' } }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, error);
    const value = JSON.parse(output);
    assert.equal(value.cwd, directory.replace('/var/', '/private/var/'));
    assert.equal(value.env.REF_KEY, 'own-reference'); assert.equal(value.env.ACCESS_TOKEN, undefined); assert.equal(value.env.SITECAD_BRIDGE_TOKEN, undefined); assert.equal(value.env.SITECAD_MCP_LAUNCH_OTHER, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('launcher rejects relative commands, non-string arguments and reserved credentials', () => {
  for (const value of [{ command: 'node', cwd: '/app' }, { command: '/app/node', cwd: '/app', args: [1] }, { command: '/app/node', cwd: '/app', env: { ACCESS_TOKEN: 'secret' } }, { command: '/app/node', cwd: '/app', env: { SITECAD_BRIDGE_TOKEN: 'secret' } }]) assert.throws(() => launcherOptions(value));
  assert.equal(launcherOptions({ command: process.execPath, cwd: '/app', env: {} }).env.ELECTRON_RUN_AS_NODE, '1');
});
