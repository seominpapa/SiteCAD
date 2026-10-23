import test from 'node:test';
import assert from 'node:assert/strict';
import { launcherOptions } from '../lib/mcp-launcher.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
