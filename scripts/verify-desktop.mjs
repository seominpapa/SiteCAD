import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessTree } from '../lib/mcp-launcher.mjs';
import { testDrawingNames } from './package-drawings.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
export async function verifyPackagedDrawings(appRoot) {
  return Promise.all(testDrawingNames.map(async name => {
    const bytes = await readFile(join(appRoot, 'drawings', 'Test', name));
    const sha256 = hash(bytes);
    assert.equal(sha256, hash(await readFile(new URL(`../drawings/Test/${name}`, import.meta.url))), `Packaged test drawing must match source: ${name}`);
    return { name, bytes: bytes.length, sha256 };
  }));
}
export const sanitizeDiagnostic = value => String(value ?? '').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
  .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[redacted]');
const readyExpression = `(() => {
  const frame=document.querySelector('#editor');
  let editor;
  try {
    const content=frame?.contentDocument;
    editor={readyState:content?.readyState,title:content?.title,
      text:content?.body?.innerText?.slice(0,1500),canvasCount:content?.querySelectorAll('canvas').length,
      controlPresent:Boolean(frame?.contentWindow?.ocsControl)};
  } catch { editor={unavailable:true}; }
  return JSON.stringify({
  title:document.title,
  editorReady:document.querySelector('#editor-stage')?.getAttribute('aria-busy')==='false' && document.querySelector('#new-drawing')?.disabled===false && document.querySelector('#editor')?.inert===false,
  settingsReady:document.querySelector('#settings-open')?.hidden===false,
  settingsTabs:document.querySelectorAll('#settings-dialog [role="tab"]').length,
  documentStatus:document.querySelector('#document-status')?.textContent,
  overlayText:document.querySelector('#editor-progress-text')?.textContent?.slice(0,1500),
  notice:document.querySelector('#workspace-notice')?.textContent?.slice(0,1000),editor
}); })()`;

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolveSocket(socket), { once: true });
    socket.addEventListener('error', () => reject(Error('Desktop debugger connection failed')), { once: true });
    setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) { socket.close(); reject(Error('Desktop debugger connection timed out')); } }, 5000).unref();
  });
}

function protocol(socket, onEvent) {
  let next = 0;
  const pending = new Map();
  const fail = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Desktop debugger disconnected')); } pending.clear(); };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  socket.addEventListener('message', event => {
    let value;
    try { value = JSON.parse(event.data); } catch { fail(); return; }
    if (value.method) { onEvent(value); return; }
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

export async function findDesktopPage(port, request = fetch) {
  try {
    const response = await request(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return (await response.json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
  } catch (error) {
    // The debugger can announce its port before the app finishes starting.
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
}

export async function closeWindowsDesktop(child) {
  if (process.env.CI !== 'true' || process.platform !== 'win32') throw Error('Normal-close verification requires a clean Windows CI desktop');
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null);
  const script = `$SitecadProcessId=${child.pid}\n${await readFile(new URL('./close-desktop-windows.ps1', import.meta.url), 'utf8')}`;
  try {
    await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {timeout:35000,maxBuffer:32768,windowsHide:true});
  } catch (error) {
    throw Error(`Windows close confirmation failed (${error.code ?? 'unknown'}): ${sanitizeDiagnostic(error.stderr).slice(-3000)}\n${sanitizeDiagnostic(error.stdout).slice(-12000)}`);
  }
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', {signal:AbortSignal.timeout(5000)});
  assert.equal(child.signalCode, null, 'Normal close must not terminate by signal');
  assert.equal(child.exitCode, 0, 'Normal close must return a successful exit code');
}

export async function verifyDesktop({ executable, outputDirectory, normalClose = false } = {}) {
  // shortcut: clean CI profiles only; add explicit isolated-profile support before local desktop use.
  if (process.env.CI !== 'true') throw Error('Desktop verification requires a clean CI machine; personal profiles must not be used.');
  if (normalClose && process.platform !== 'win32') throw Error('Normal-close verification currently requires Windows');
  if (!isAbsolute(executable ?? '')) throw Error('Provide an absolute executable path');
  if (!(await stat(executable)).isFile()) throw Error('Desktop executable must be a file');
  if (!isAbsolute(outputDirectory ?? '')) throw Error('Provide an absolute output directory');
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = Date.now();
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
    shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false,
  });
  let output = '', startupError, socket, call, stage = 'debugger startup', lastState;
  let rendererEvents = [], discoveryAttempts = 0;
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
      discoveryAttempts++;
      return findDesktopPage(port);
    }, stage);
    assert.match(target.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/page/`));
    socket = await connect(target.webSocketDebuggerUrl);
    call = protocol(socket, ({method,params}) => {
      let detail;
      if (method === 'Runtime.exceptionThrown') detail = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text;
      if (method === 'Runtime.consoleAPICalled') detail = `${params.type}: ${(params.args ?? []).map(arg => arg.value ?? arg.description ?? arg.type).join(' ')}`;
      if (method === 'Log.entryAdded') detail = `${params.entry?.level}: ${params.entry?.text}`;
      if (detail) rendererEvents = [...rendererEvents.slice(-39), {method,detail:sanitizeDiagnostic(detail).slice(0,2000)}];
    });
    await call('Runtime.enable');
    await call('Log.enable');
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
    stage = 'packaged test drawings';
    const testDrawings = await verifyPackagedDrawings(join(dirname(executable), process.platform === 'darwin' ? '../Resources/app' : 'resources/app'));
    stage = 'desktop screenshot';
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(outputDirectory, 'desktop.png'), Buffer.from(screenshot.data, 'base64'));
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const report = { version, platform: process.platform, arch: process.arch, ...view, modules, testDrawings, anonymousProfile: true,
      startupMs: Date.now() - startedAt, discoveryAttempts,
      shutdownMethod: normalClose ? 'native close confirmation' : 'forced process-tree termination',
      limitations: ['No AI inference or authenticated external API/MCP calls', 'No drawing modification or DWG round-trip test'] };
    if (normalClose) {
      stage = 'normal Windows close confirmation';
      await closeWindowsDesktop(child);
      report.normalCloseVerified = true;
    }
    await writeFile(join(outputDirectory, 'desktop-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Desktop ${version} verified on ${process.platform}/${process.arch}: editor, settings and packaged chat modules ready`);
    return report;
  } catch (error) {
    if (call && socket?.readyState === WebSocket.OPEN) {
      try {
        const screenshot = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
        await writeFile(join(outputDirectory, 'desktop-failure.png'), Buffer.from(screenshot.data, 'base64'));
      } catch { /* Diagnostic capture must preserve the original verification failure. */ }
    }
    const failure = {platform:process.platform, arch:process.arch, stage, error:sanitizeDiagnostic(error.message),
      elapsedMs:Date.now() - startedAt, discoveryAttempts,
      exitCode:child.exitCode, signalCode:child.signalCode, lastState, rendererEvents, stderr:sanitizeDiagnostic(output)};
    const diagnostic = sanitizeDiagnostic(JSON.stringify(failure, null, 2));
    try { await writeFile(join(outputDirectory, 'desktop-verification-failure.json'), `${diagnostic}\n`); }
    catch { console.error('Could not save desktop failure diagnostic'); }
    console.error(`Desktop verification failed during ${stage}: ${sanitizeDiagnostic(error.message)}`);
    console.error(diagnostic);
    throw error;
  } finally {
    try { socket?.close(); } catch { /* Cleanup must preserve the original verification failure. */ }
    await stopDesktop(child);
  }
}

if (import.meta.main) {
  await verifyDesktop({ executable: process.argv[2], outputDirectory: process.argv[3], normalClose: process.argv.includes('--normal-close') });
}
