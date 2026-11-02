import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectLocalFolder } from '../lib/local-platform.mjs';

test('macOS folder picker passes paths as arguments and distinguishes cancellation from errors', async t => {
  const path = await mkdtemp(join(tmpdir(), 'sitecad-picker-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  let call;
  const signal = new AbortController().signal;
  const executeImpl = async (...args) => { call = args; return { stdout: '/private/tmp/한글 도면/\n' }; };
  assert.equal(await selectLocalFolder({ defaultPath: path, platform: 'darwin', signal, executeImpl }), '/private/tmp/한글 도면/');
  assert.equal(call[0], '/usr/bin/osascript');
  assert.equal(call[1].at(-1), path);
  assert.match(call[1][1], /choose folder/);
  assert.equal(call[2].signal, signal);
  assert.equal(call[2].shell, undefined);
  assert.equal(await selectLocalFolder({ defaultPath: join(path, 'missing'), platform: 'darwin', executeImpl: async (...args) => { call = args; return { stdout: '\n' }; } }), null);
  assert.equal(call[1].at(-1), homedir());
  await assert.rejects(selectLocalFolder({ defaultPath: path, platform: 'darwin', executeImpl: async () => { throw Error('private OS error'); } }), /폴더/);
});

test('Windows folder picker uses STA and safely encodes paths with UTF8 output', async () => {
  const initial = "C:\\Users\\person\\한글 '$folder`", chosen = 'D:\\도면 폴더'; let call;
  const executeImpl = async (...args) => { call = args; return { stdout: chosen + '\r\n' }; };
  assert.equal(await selectLocalFolder({ defaultPath: initial, platform: 'win32', executeImpl }), chosen);
  assert.ok(call[1].includes('-STA'));
  const script = Buffer.from(call[1].at(-1), 'base64').toString('utf16le');
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /OutputEncoding/);
  assert.equal(script.includes(initial), false);
  assert.equal(script.includes(Buffer.from(initial).toString('base64')), true);
  assert.equal(call[2].windowsHide, true);
  assert.equal(await selectLocalFolder({ defaultPath: initial, platform: 'win32', executeImpl: async () => ({ stdout: '' }) }), null);
  await assert.rejects(selectLocalFolder({ defaultPath: '/tmp', platform: 'linux', executeImpl }), /지원/);
});
