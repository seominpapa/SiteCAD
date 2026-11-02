import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { buildLocalWeb } from '../scripts/build-local-web.mjs';
import { verifyCodexInstallation } from '../scripts/install-codex.mjs';
import { stopProcessTree } from '../lib/mcp-launcher.mjs';

const execute = promisify(execFile);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const redacted = value => value.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]').replace(/(-EncodedCommand\s+)[A-Za-z0-9+/=]+/gi, '$1[redacted]').slice(-4000);
const windows = process.platform === 'win32';
const macos = process.platform === 'darwin' && process.env.SITECAD_TEST_FRESH_INSTALL === '1';

test('native launcher diagnostics redact browser capabilities and encoded commands', () => {
  const diagnostic = redacted('failed: http://127.0.0.1:1234/launch?token=private-capability -EncodedCommand cHJpdmF0ZQ==');
  assert.match(diagnostic, /failed: \[redacted URL\] -EncodedCommand \[redacted\]/);
  assert.doesNotMatch(diagnostic, /private-capability|cHJpdmF0ZQ==/);
  assert.equal(redacted('x'.repeat(5000)).length, 4000);
});

test('fresh native release launcher installs private runtimes, opens the protected service and reuses its installation', {
  skip: !windows && !macos, timeout: 15 * 60 * 1000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'SiteCAD 실제 설치 한글 space '));
  const extracted = join(directory, '압축 해제 with spaces');
  const root = join(extracted, 'SiteCAD');
  const dataDir = join(directory, '사용자 데이터');
  const nativeArch = windows ? (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE).toUpperCase() === 'ARM64' ? 'arm64' : 'x64' : process.arch;
  const privateNode = join(root, '.runtime/local-web', `node-v24.22.1-${windows ? 'win' : 'darwin'}-${nativeArch}`, windows ? 'node.exe' : 'bin/node');
  const executable = windows ? process.env.ComSpec || 'cmd.exe' : '/bin/bash';
  const args = windows ? ['/d', '/s', '/c', `""${join(root, 'Start SiteCAD.cmd')}""`] : [join(root, 'Start SiteCAD.command')];
  const launchOptions = { cwd: root, env: { ...process.env, SITECAD_WEB_DATA_DIR: dataDir },
    ...(windows ? { windowsVerbatimArguments: true, windowsHide: true } : { detached: true }) };
  let child;
  try {
    const archive = await buildLocalWeb({ platform: process.platform, outputDirectory: join(directory, 'release') });
    if (windows) {
      const command = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(extracted)}`;
      await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { timeout: 60000 });
    } else await execute('/usr/bin/unzip', ['-q', archive, '-d', extracted], { timeout: 60000 });
    for (const name of ['.runtime', 'node_modules', 'runtime']) await assert.rejects(stat(join(root, name)), { code: 'ENOENT' });
    for (const name of ['public/chat-content.js', 'public/settings.js', 'skills/quantity-review/SKILL.md']) assert.ok((await stat(join(root, name))).isFile(), name);
    child = spawn(executable, args, { ...launchOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('\r\n');
    // Do not publish browser launch capabilities or inherited account data in CI output.
    let startupComplete = false;
    let output = '';
    let errors = '';
    const diagnostics = () => redacted(`${output}\n${errors}`);
    let failure;
    child.once('error', error => { failure = error; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => {
      output = (output + bytes.toString('utf8')).slice(-65536);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-65536); });
    let runtime;
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, `Native launcher exited before readiness (code ${child.exitCode})\n${diagnostics()}`);
      assert.equal(child.signalCode, null, `Native launcher stopped before readiness\n${diagnostics()}`);
      try { runtime = JSON.parse(await readFile(join(dataDir, 'local-web-runtime.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      startupComplete = Boolean(runtime && output.includes(`http://127.0.0.1:${runtime.port}/`));
      if (startupComplete) break;
      await delay(1000);
    }
    assert.ok(runtime && startupComplete, `Private runtime installation and browser opening did not finish within 12 minutes\n${diagnostics()}`);
    assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
    assert.ok(Number.isSafeInteger(runtime.port) && runtime.port > 0 && runtime.port < 65536);
    const baseUrl = `http://127.0.0.1:${runtime.port}`;
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, 'Anonymous visitors may open only the safe browser connection page');
    const landing = await response.text();
    assert.match(landing, /이 브라우저로 연결/);
    assert.doesNotMatch(landing, /<iframe|browser-start\.js|app\.js/);
    for (const path of ['/app/', '/api/health', '/api/desktop/status']) {
      const denied = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(denied.status, 403, `Private path ${path} must require the browser capability`);
      await denied.body?.cancel();
    }
    assert.equal((await execute(privateNode, ['--version'])).stdout.trim(), 'v24.22.1');
    assert.equal((await execute(privateNode, ['-p', 'process.arch'])).stdout.trim(), nativeArch);
    const readyFile = join(root, '.runtime/local-web/dependencies.ready');
    assert.match((await readFile(readyFile, 'utf8')).trim(), new RegExp(`-${nativeArch}-24\\.22\\.1${windows ? '-win32' : ''}-node-only$`));
    assert.ok((await stat(join(root, 'node_modules/.package-lock.json'))).isFile());
    const codex = await verifyCodexInstallation(join(root, 'runtime'), { platform: process.platform, arch: nativeArch });
    assert.match((await execute(codex, ['--version'], { timeout: 15000 })).stdout, /0\.163\.0/);
    const encrypted = await readFile(join(dataDir, 'credentials.enc'));
    const magic = Buffer.from('SITECADWEB1\0');
    assert.ok(encrypted.subarray(0, magic.length).equals(magic), 'Anonymous startup record must be encrypted');
    await execute(privateNode, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { createNodeSecretStores } from './lib/node-secret-store.mjs';
const stores = createNodeSecretStores({ dataDir: process.argv[1] });
const account = await stores.auth.read();
assert.ok(account && Array.isArray(account.registrations) && account.registrations.length === 0 && account.activeClientId === null, 'Fresh installation must contain only an anonymous account record');
assert.ok(!/access_?token|refresh_?token/i.test(JSON.stringify(account)), 'Fresh installation must not inherit OAuth tokens');
const mcp = await stores.mcp.read();
assert.ok(mcp === null || (mcp.records && Object.keys(mcp.records).length === 0), 'Fresh installation must not inherit MCP secrets');
assert.ok(await stores.references.read() === null, 'Fresh installation must not inherit VWorld credentials');
assert.ok(await stores.llm.read() === null, 'Fresh installation must not inherit LLM API credentials');
assert.ok(await stores.apis.read() === null, 'Fresh installation must not inherit external API credentials');
`, dataDir], { cwd: root, timeout: 30000 });
    assert.equal((await readdir(join(root, 'node_modules'))).includes('rea-agents'), false, 'Fresh production install must not include development REA');
    const before = await Promise.all([readyFile, join(root, 'node_modules/.package-lock.json')].map(file => stat(file)));
    let second;
    try { second = await execute(executable, args, { ...launchOptions, timeout: 60000 }); }
    catch (error) { assert.fail(`Second launcher failed\n${redacted(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)}`); }
    assert.match(redacted(second.stdout), /로컬 웹앱 연결됨/);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'local-web-runtime.json'), 'utf8')).pid, runtime.pid);
    const after = await Promise.all([readyFile, join(root, 'node_modules/.package-lock.json')].map(file => stat(file)));
    assert.deepEqual(after.map(item => item.mtimeMs), before.map(item => item.mtimeMs), 'Second launch must reuse installed dependencies');
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      stopProcessTree(child, 'SIGKILL', { killGroup: !windows });
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    try {
      if (await stat(join(dataDir, 'credentials.enc')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) {
        await execute(privateNode, ['--input-type=module', '-e', `
import { AsyncEntry } from '@napi-rs/keyring';
import { createHash } from 'node:crypto';
await new AsyncEntry('SiteCAD Web', createHash('sha256').update(process.argv[1]).digest('hex')).deletePassword();
`, dataDir], { cwd: root, timeout: 30000 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
  }
});
