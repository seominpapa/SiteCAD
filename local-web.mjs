import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer as createIpcServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from './server.mjs';
import { createDesktopController } from './lib/desktop-controller.mjs';
import { createBrowserAccess } from './lib/browser-access.mjs';
import { createNodeSecretStores } from './lib/node-secret-store.mjs';
import { desktopPaths, installBundledCodex, isAllowedAuthUrl } from './desktop/runtime.mjs';

const execute = promisify(execFile);
const appRoot = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = () => join(homedir(), 'Library', 'Application Support', 'SiteCAD Web');
const openMac = async value => { await execute('/usr/bin/open', [value], { timeout: 15000, maxBuffer: 4096 }); };

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (cause) { if (cause.code === 'ESRCH') return false; if (cause.code === 'EPERM') return true; throw cause; }
}

async function claimSocket(ipc, directory, prefix) {
  const proposal = join(directory, `.${prefix}.${randomUUID()}.owner`);
  await writeFile(proposal, JSON.stringify({ pid: process.pid, retired: false }), { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 15000;
  try {
    // shortcut: retain up to 4096 generations per temporary directory lifetime; add coordinated compaction if reached.
    for (let generation = 0; generation < 4096; generation++) {
      const stem = join(directory, `${prefix}${generation ? `-${generation}` : ''}`);
      const marker = `${stem}.owner`; const socketPath = `${stem}.sock`;
      let owned = false;
      try { await link(proposal, marker); owned = true; }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      if (!owned) {
        const info = await lstat(marker);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > 200) throw Error('SiteCAD 실행기 잠금 정보를 확인해 주세요.');
        const owner = JSON.parse(await readFile(marker, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.retired !== 'boolean') throw Error('SiteCAD 실행기 잠금 정보를 확인해 주세요.');
        if (owner.retired || !alive(owner.pid)) {
          const legacy = await activate(socketPath);
          if (legacy) return { running: legacy };
          continue;
        }
        const running = await activate(socketPath);
        if (running) return { running };
        if (Date.now() >= deadline) throw Error('SiteCAD 실행기가 시작 중이거나 응답하지 않습니다. 잠시 후 다시 실행해 주세요.');
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
        generation--; continue;
      }
      const retire = async () => {
        const temporary = `${marker}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ pid: process.pid, retired: true }), { flag: 'wx', mode: 0o600 });
          await rename(temporary, marker);
        } finally { await rm(temporary, { force: true }); }
      };
      // Complete PID records are linked atomically; shared stale paths are never deleted or reused.
      try {
        const legacy = await activate(socketPath);
        if (legacy) { await retire(); return { running: legacy }; }
        await new Promise((resolveListen, reject) => {
          const onError = cause => { ipc.off('listening', onListen); reject(cause); };
          const onListen = () => { ipc.off('error', onError); resolveListen(); };
          ipc.once('error', onError); ipc.once('listening', onListen); ipc.listen(socketPath);
        });
        await chmod(socketPath, 0o600);
        return { socketPath, retire };
      } catch (cause) {
        await retire();
        if (ipc.listening) await new Promise(resolveClose => ipc.close(resolveClose));
        if (cause.code !== 'EADDRINUSE') throw cause;
        const info = await lstat(socketPath);
        if (!info.isSocket() || info.uid !== process.getuid()) throw Error('SiteCAD 실행기 연결 파일을 확인해 주세요.');
      }
    }
    throw Error('SiteCAD 실행기 연결 기록이 4096개에 도달했습니다. 실행 중인 SiteCAD를 모두 종료한 뒤 임시 연결 기록을 정리해 주세요.');
  } finally { await rm(proposal, { force: true }); }
}

async function activate(socketPath) {
  return new Promise((resolveActivation, reject) => {
    const client = createConnection(socketPath); let text = '';
    client.setTimeout(15000, () => client.destroy(Error('실행 중인 SiteCAD가 응답하지 않습니다. 잠시 후 다시 실행해 주세요.')));
    client.on('connect', () => client.write('open\n'));
    client.on('data', chunk => { text += chunk; if (text.length > 1024) client.destroy(Error('잘못된 실행기 응답입니다.')); });
    client.on('error', cause => { if (['ENOENT', 'ECONNREFUSED'].includes(cause.code)) resolveActivation(null); else reject(cause); });
    client.on('end', () => {
      try { const result = JSON.parse(text); if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(result.baseUrl)) throw Error(); resolveActivation(result); }
      catch { reject(Error('기존 SiteCAD 실행기에 연결하지 못했습니다.')); }
    });
  });
}

export async function startLocalWeb({ dataDir = defaultDataDir(), codexPath, entry, openBrowser = openMac,
  controllerFactory = createDesktopController, serverFactory = createApp, installSignalHandlers = true } = {}) {
  if (process.versions.electron) throw Error('SiteCAD 로컬 웹앱은 Node.js 실행기로 시작해 주세요.');
  if (!isAbsolute(dataDir)) throw Error('SiteCAD data path must be absolute');
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('SiteCAD 개인 데이터 폴더 권한을 확인해 주세요.');
  await chmod(dataDir, 0o700);
  const socketDir = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `sitecad-web-${process.getuid()}`);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  const socketInfo = await lstat(socketDir);
  if (!socketInfo.isDirectory() || socketInfo.isSymbolicLink() || socketInfo.uid !== process.getuid()) throw Error('SiteCAD 실행기 폴더 권한을 확인해 주세요.');
  await chmod(socketDir, 0o700);
  let controller; let server; let baseUrl; let closePromise; let readyResolve; let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  ready.catch(() => {});
  const browserAccess = createBrowserAccess();
  const record = join(dataDir, 'local-web-runtime.json');
  const clients = new Set();
  const ipc = createIpcServer(client => {
    clients.add(client); client.once('close', () => clients.delete(client));
    let input = '';
    client.setTimeout(15000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', chunk => {
      input += chunk;
      if (input.length > 16 || !'open\n'.startsWith(input)) { client.destroy(); return; }
      if (input === 'open\n') {
        client.pause();
        void ready.then(async () => { await openBrowser(browserAccess.launchUrl(baseUrl)); client.end(JSON.stringify({ baseUrl })); }).catch(() => client.destroy());
      }
    });
  });
  const claim = await claimSocket(ipc, socketDir, createHash('sha256').update(dataDir).digest('hex').slice(0, 24));
  if (claim.running) return { ...claim.running, dataDir, reused: true, close: async () => {} };
  const { socketPath, retire } = claim;
  const signalHandler = () => { void close().catch(() => { process.exitCode = 1; }); };
  function close() {
    closePromise ??= (async () => {
      if (installSignalHandlers) for (const name of ['SIGINT', 'SIGTERM']) process.off(name, signalHandler);
      let closeError;
      try { await controller?.close(); } catch (cause) { closeError = cause; }
      finally {
        if (server?.listening) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
        for (const client of clients) client.destroy();
        try { await rm(record, { force: true }); await retire(); }
        finally {
          // Node removes its socket when closing; an extra unlink could remove a newly started listener.
          if (ipc.listening) await new Promise(resolveClose => ipc.close(resolveClose));
        }
      }
      if (closeError) throw closeError;
    })();
    return closePromise;
  }
  try {
    const paths = desktopPaths(dataDir);
    for (const directory of [paths.codexHome, paths.workspace, paths.runtime]) await mkdir(directory, { recursive: true, mode: 0o700 });
    codexPath ??= await installBundledCodex({ sourceDir: join(appRoot, 'runtime'), destination: join(paths.runtime, 'codex') });
    const stores = createNodeSecretStores({ dataDir, entry });
    controller = await controllerFactory({ dataDir, codexPath, nodePath: process.execPath, nodeEnv: {},
      secureStore: stores.auth, mcpSecretStore: stores.mcp, referenceSecretStore: stores.references,
      reaSource: join(appRoot, 'node_modules/rea-agents'), modelCatalogPath: join(appRoot, 'codex-models.json'),
      openExternal: async url => { if (!isAllowedAuthUrl(url)) throw Error('허용되지 않은 로그인 주소입니다.'); await openBrowser(url); } });
    const fixture = join(appRoot, 'fixtures', 'retaining-wall.dwg');
    const fixturePath = await stat(fixture).then(value => value.isFile()).catch(() => false) ? fixture
      : join(appRoot, '../rhino-experiments/retaining-wall-20261020/retaining-wall-drawing-2d.dwg');
    server = serverFactory({ desktop: controller, browserAccess, fixturePath, browserActions: {
      openDrawings: async () => { const path = join(dataDir, 'Drawings'); await mkdir(path, { recursive: true, mode: 0o700 }); await openMac(path); },
      quit: async () => { setTimeout(() => { void close().catch(() => { process.exitCode = 1; }); }, 100); },
    } });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await controller.start({ baseUrl });
    const temporary = `${record}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, port: server.address().port }), { mode: 0o600 });
    await rename(temporary, record);
    if (installSignalHandlers) for (const name of ['SIGINT', 'SIGTERM']) process.on(name, signalHandler);
    readyResolve();
    await openBrowser(browserAccess.launchUrl(baseUrl));
    return { dataDir, baseUrl, reused: false, close };
  } catch (cause) { readyReject(cause); await close(); throw cause; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocalWeb({ ...(process.env.SITECAD_WEB_DATA_DIR ? { dataDir: process.env.SITECAD_WEB_DATA_DIR } : {}) }).then(instance => {
    console.log(`SiteCAD 로컬 웹앱 ${instance.reused ? '연결됨' : '실행 중'}: ${instance.baseUrl}/`);
    if (!instance.reused) console.log('브라우저를 닫아도 서버는 유지됩니다. 화면의 실행기 종료를 사용해 주세요.');
  }).catch(cause => { console.error(cause.message); process.exitCode = 1; });
}
