import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessTree } from '../lib/mcp-launcher.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sanitized = value => String(value ?? '').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
  .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
const readyExpression = `JSON.stringify({
  title:document.title,
  editorReady:document.querySelector('#editor-stage')?.getAttribute('aria-busy')==='false' && document.querySelector('#new-drawing')?.disabled===false && document.querySelector('#editor')?.inert===false,
  settingsReady:document.querySelector('#settings-open')?.hidden===false,
  settingsTabs:document.querySelectorAll('#settings-dialog [role="tab"]').length,
  documentStatus:document.querySelector('#document-status')?.textContent
})`;

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolveSocket(socket), { once: true });
    socket.addEventListener('error', () => reject(Error('Desktop debugger connection failed')), { once: true });
    setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) { socket.close(); reject(Error('Desktop debugger connection timed out')); } }, 5000).unref();
  });
}

function protocol(socket) {
  let next = 0;
  const pending = new Map();
  const fail = () => { for (const entry of pending.values()) entry.reject(Error('Desktop debugger disconnected')); pending.clear(); };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  socket.addEventListener('message', event => {
    let value;
    try { value = JSON.parse(event.data); } catch { fail(); return; }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.error) entry.reject(Error(`Desktop debugger rejected ${entry.method}`)); else entry.resolve(value.result);
  });
  return (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Desktop debugger timed out: ${method}`)); }, 5000);
    pending.set(id, { resolve: resolveCall, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

export async function stopDesktop(child, timeoutMs = 5000, stop = stopProcessTree) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStop => {
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolveStop(); };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
    try { stop(child, 'SIGKILL'); } catch { finish(); }
  });
}

export async function verifyDesktop({ executable, outputDirectory } = {}) {
  // shortcut: clean CI profiles only; add explicit isolated-profile support before local desktop use.
  if (process.env.CI !== 'true') throw Error('Desktop verification requires a clean CI machine; personal profiles must not be used.');
  if (!isAbsolute(executable ?? '')) throw Error('Provide an absolute executable path');
  if (!(await stat(executable)).isFile()) throw Error('Desktop executable must be a file');
  if (!isAbsolute(outputDirectory ?? '')) throw Error('Provide an absolute output directory');
  await mkdir(outputDirectory, { recursive: true });
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
    shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false,
  });
  let output = '', startupError, socket, stage = 'debugger startup', lastState;
  child.once('error', error => { startupError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { output = (output + text).slice(-32768); });
  const deadline = Date.now() + 90000;
  async function until(action, label) {
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Desktop exited before verification: ${child.exitCode ?? child.signalCode}`);
      const result = await action();
      if (result) return result;
      await delay(250);
    }
    throw Error(`Desktop verification timed out: ${label}`);
  }
  try {
    const port = await until(async () => output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1], stage);
    stage = 'local application page';
    const target = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      return (await response.json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
    }, stage);
    assert.match(target.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/page/`));
    socket = await connect(target.webSocketDebuggerUrl);
    const call = protocol(socket);
    stage = 'CAD editor and unified settings readiness';
    const view = await until(async () => {
      const response = await call('Runtime.evaluate', { expression: readyExpression, returnByValue: true });
      if (response.exceptionDetails || typeof response.result?.value !== 'string') return;
      const state = JSON.parse(response.result.value);
      lastState = state;
      return state.editorReady && state.settingsReady ? state : undefined;
    }, stage);
    assert.match(view.title, /SiteCAD/); assert.equal(view.settingsTabs, 5);
    stage = 'anonymous profile and packaged modules';
    const baseUrl = new URL(target.url).origin;
    const statusResponse = await fetch(`${baseUrl}/api/desktop/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.ok, true); assert.equal(status.data.desktop, true);
    assert.equal(status.data.oauth.connected, false, 'Clean VM must not inherit real AI credentials');
    const modules = {};
    for (const name of ['chat-content.js', 'settings.js']) {
      const response = await fetch(`${baseUrl}/${name}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const servedHash = hash(Buffer.from(await response.arrayBuffer()));
      assert.equal(servedHash, hash(await readFile(new URL(`../public/${name}`, import.meta.url))), `Packaged ${name} must match tested source`);
      modules[name] = servedHash;
    }
    stage = 'desktop screenshot';
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(outputDirectory, 'desktop.png'), Buffer.from(screenshot.data, 'base64'));
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const report = { version, platform: process.platform, arch: process.arch, ...view, modules, anonymousProfile: true,
      limitations: ['No AI inference or authenticated external API/MCP calls', 'No drawing modification or DWG round-trip test'] };
    await writeFile(join(outputDirectory, 'desktop-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Desktop ${version} verified on ${process.platform}/${process.arch}: editor, settings and packaged chat modules ready`);
    return report;
  } catch (error) {
    const failure = {platform:process.platform, arch:process.arch, stage, error:sanitized(error.message),
      exitCode:child.exitCode, signalCode:child.signalCode, lastState, stderr:sanitized(output)};
    try { await writeFile(join(outputDirectory, 'desktop-verification-failure.json'), `${JSON.stringify(failure, null, 2)}\n`); }
    catch { console.error('Could not save desktop failure diagnostic'); }
    console.error(`Desktop verification failed during ${stage}: ${sanitized(error.message)}`);
    if (output) console.error(sanitized(output));
    throw error;
  } finally {
    try { socket?.close(); } catch { /* Cleanup must preserve the original verification failure. */ }
    await stopDesktop(child);
  }
}

if (import.meta.main) {
  await verifyDesktop({ executable: process.argv[2], outputDirectory: process.argv[3] });
}
