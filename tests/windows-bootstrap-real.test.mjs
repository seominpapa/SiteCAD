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

test('fresh Windows release double-click installs its private runtimes and opens the local browser service', {
  skip: process.platform !== 'win32', timeout: 15 * 60 * 1000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'SiteCAD 실제 설치 한글 space '));
  const extracted = join(directory, '압축 해제 with spaces');
  const root = join(extracted, 'SiteCAD');
  const dataDir = join(directory, '사용자 데이터');
  let child;
  try {
    const archive = await buildLocalWeb({ platform: 'win32', outputDirectory: join(directory, 'release') });
    const command = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(extracted)}`;
    await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { timeout: 60000 });
    for (const name of ['.runtime', 'node_modules', 'runtime']) await assert.rejects(stat(join(root, name)), { code: 'ENOENT' });
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(root, 'Start SiteCAD.cmd')}""`], {
      cwd: root, env: { ...process.env, SITECAD_WEB_DATA_DIR: dataDir }, windowsVerbatimArguments: true,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('\r\n');
    // Do not publish browser launch capabilities or inherited account data in CI output.
    let startupComplete = false;
    let output = '';
    let errors = '';
    const diagnostics = () => `${output}\n${errors}`.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]').replace(/(-EncodedCommand\s+)[A-Za-z0-9+/=]+/gi, '$1[redacted]').slice(-4000);
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
      assert.equal(child.exitCode, null, `Windows launcher exited before readiness (code ${child.exitCode})\n${diagnostics()}`);
      assert.equal(child.signalCode, null, `Windows launcher stopped before readiness\n${diagnostics()}`);
      try { runtime = JSON.parse(await readFile(join(dataDir, 'local-web-runtime.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      startupComplete = Boolean(runtime && output.includes(`http://127.0.0.1:${runtime.port}/`));
      if (startupComplete) break;
      await delay(1000);
    }
    assert.ok(runtime && startupComplete, `Private runtime installation and browser opening did not finish within 12 minutes\n${diagnostics()}`);
    assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
    assert.ok(Number.isSafeInteger(runtime.port) && runtime.port > 0 && runtime.port < 65536);
    const response = await fetch(`http://127.0.0.1:${runtime.port}/`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 403, 'Local HTTP service must reject a request without its browser capability');
    await response.body?.cancel();
    const nativeArch = (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE).toUpperCase() === 'ARM64' ? 'arm64' : 'x64';
    const privateNode = join(root, '.runtime/local-web', `node-v24.22.1-win-${nativeArch}`, 'node.exe');
    assert.equal((await execute(privateNode, ['--version'])).stdout.trim(), 'v24.22.1');
    assert.equal((await execute(privateNode, ['-p', 'process.arch'])).stdout.trim(), nativeArch);
    assert.match(await readFile(join(root, '.runtime/local-web/dependencies.ready'), 'utf8'), new RegExp(`-${nativeArch}-24\\.22\\.1-win32-node-only$`));
    assert.ok((await stat(join(root, 'node_modules/.package-lock.json'))).isFile());
    const codex = await verifyCodexInstallation(join(root, 'runtime'), { platform: 'win32', arch: nativeArch });
    assert.match((await execute(codex, ['--version'], { timeout: 15000 })).stdout, /0\.163\.0/);
    for (const name of ['credentials.enc', 'mcp-secrets.enc', 'vworld-secrets.enc']) await assert.rejects(stat(join(dataDir, name)), { code: 'ENOENT' });
    assert.ok((await readdir(join(root, 'node_modules'))).includes('rea-agents'));
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      stopProcessTree(child, 'SIGKILL');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
});
