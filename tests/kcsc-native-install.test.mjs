import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createKcscInstaller } from '../lib/kcsc-runtime.mjs';
import { probeKcsc, KCSC_QUERY_TOOLS } from '../lib/kcsc-connection.mjs';
import { stopProcessTree } from '../lib/mcp-launcher.mjs';

function diagnosticExecutor(diagnostic) {
  const sanitized = text => text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]').slice(-4000);
  return (command, args, { cwd, env, signal, maxBuffer = 1024 * 1024, timeoutMs = 240000 } = {}) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [], errors = [];
    let bytes = 0, failed = false;
    const stop = () => { if (!failed) { failed = true; stopProcessTree(child, 'SIGKILL', { killGroup: true }); } };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) stop(); else output.push(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) stop(); else errors.push(chunk); });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (failed || code !== 0) {
        diagnostic(sanitized(`KCSC stage ${basename(command)} ${args.join(' ')} (exit ${code}):\n${Buffer.concat(errors).toString('utf8')}`));
        reject(Error('KCSC native process failed; see anonymous stage diagnostic'));
      } else resolve({ stdout: Buffer.concat(output) });
    });
    if (signal?.aborted) stop();
  });
}

test('anonymous KCSC process failures preserve bounded stage diagnostics without URLs', async () => {
  const diagnostics = [];
  const execute = diagnosticExecutor(message => diagnostics.push(message));
  await assert.rejects(execute(process.execPath, ['-e', 'process.stderr.write("download failed https://example.invalid/?token=private");process.exit(7)'], {
    cwd: tmpdir(), env: {},
  }), /KCSC native process failed/);
  assert.match(diagnostics[0], /download failed \[redacted URL\]/);
  assert.doesNotMatch(diagnostics[0], /example\.invalid|token=private/);
});

test('anonymous KCSC diagnostic executor retains binary output and stops stalled children', async () => {
  const execute = diagnosticExecutor(() => {});
  assert.deepEqual((await execute(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,1]))'], { env: {} })).stdout, Buffer.from([0,255,1]));
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, timeoutMs: 20 }), /KCSC native process failed/);
  await assert.rejects(execute(process.execPath, ['-e', 'process.stderr.write("too much output")'], { env: {}, maxBuffer: 4 }), /KCSC native process failed/);
});

test('native pinned KCSC bootstrap installs isolated Python and discovers real MCP tools without credentials', {
  skip: process.env.SITECAD_TEST_KCSC_INSTALL !== '1', timeout: 600000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'SiteCAD KCSC native '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const installer = createKcscInstaller({ dataDir, execute: diagnosticExecutor(message => t.diagnostic(message)) });
  assert.equal((await installer.status()).installed, false);
  const installed = await installer.install();
  assert.equal(installed.installed, true);
  assert.equal((await installer.status()).command, installed.command);
  const result = await probeKcsc({ ...installed, env: { KCSC_DOMAIN: '전체' } }, { dataDir, verifyKey: false });
  assert.equal(result.verified, false);
  assert.equal(result.tools.length, 13);
  assert.equal(KCSC_QUERY_TOOLS.every(name => result.tools.includes(name)), true);
  t.diagnostic(`Discovered ${result.tools.length} native MCP tools; ${KCSC_QUERY_TOOLS.length} query tools are enabled for SiteCAD.`);
});
