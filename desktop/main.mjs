import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import { mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createSecureStore, desktopPaths, installBundledCodex, isAllowedAuthUrl } from './runtime.mjs';
import { createBrowserAccess } from '../lib/browser-access.mjs';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const browserMode = process.argv.includes('--browser');
app.setName('SiteCAD');
// Different Electron signatures must never overwrite the installed app's encrypted credentials.
app.setPath('userData', join(app.getPath('appData'), browserMode ? 'SiteCAD Local Web' : 'SiteCAD'));
let mainWindow;
let server;
let controller;
let closing = false;
let closingPrompt = false;
let baseUrl;
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

async function closeServices() {
  await controller?.close().catch(() => {});
  if (server) await new Promise(resolveClose => {
    server.close(resolveClose);
    server.closeAllConnections();
  });
}

async function confirmClose(event) {
  if (closing) return;
  event.preventDefault();
  if (closingPrompt) return;
  closingPrompt = true;
  try {
    const options = {
      type: 'warning', buttons: ['계속 작업', '종료'], defaultId: 0, cancelId: 0,
      title: 'SiteCAD 종료', message: '저장하지 않은 도면 변경은 사라집니다.',
      detail: '필요한 도면을 DWG로 저장한 뒤 종료해 주세요. 진행 중인 AI 작업도 중단됩니다.',
    };
    const result = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
    if (result.response !== 1) return;
    closing = true;
    await closeServices();
    app.quit();
  } finally { closingPrompt = false; }
}

async function start() {
  const dataDir = app.getPath('userData');
  const paths = desktopPaths(dataDir);
  for (const directory of [paths.codexHome, paths.workspace, paths.runtime]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const codexPath = await installBundledCodex({ sourceDir: join(appRoot, 'runtime'), destination: join(paths.runtime, 'codex') });
  controller = await createDesktopController({
    dataDir, codexPath, nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    secureStore: createSecureStore({ file: paths.secrets, safeStorage }),
    mcpSecretStore: createSecureStore({ file: join(dataDir, 'mcp-secrets.enc'), safeStorage }),
    referenceSecretStore: createSecureStore({ file: join(dataDir, 'vworld-secrets.enc'), safeStorage }),
    selectTerrainFile: async () => {
      const options = { title: '지형 원본 등록 — SHP는 같은 폴더의 DBF·PRJ 필요',
        properties: ['openFile'], filters: [{ name: '지형 원본 SHP / GeoJSON', extensions: ['shp', 'geojson', 'json'] }] };
      const selection = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
      return selection.canceled ? null : selection.filePaths[0];
    },
    modelCatalogPath: join(appRoot, 'codex-models.json'),
    openExternal: async url => {
      if (!isAllowedAuthUrl(url)) throw Error('허용되지 않은 로그인 주소입니다.');
      await shell.openExternal(url);
    },
  });
  const bundledFixture = join(appRoot, 'fixtures', 'retaining-wall.dwg');
  const fixturePath = await stat(bundledFixture).then(info => info.isFile()).catch(() => false)
    ? bundledFixture : join(appRoot, '../rhino-experiments/retaining-wall-20261020/retaining-wall-drawing-2d.dwg');
  const browserAccess = browserMode ? createBrowserAccess() : undefined;
  server = createApp({ desktop: controller, fixturePath, browserAccess, browserActions: {
    openDrawings: async () => { const message = await shell.openPath(join(dataDir, 'Drawings')); if (message) throw Error('저장 폴더를 열지 못했습니다.'); },
    quit: async () => { setImmediate(() => { void confirmClose({ preventDefault() {} }).catch(() => {}); }); },
  } });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await controller.start({ baseUrl });
  if (browserMode) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'SiteCAD', submenu: [
        { label: '브라우저에서 열기', click: () => { void shell.openExternal(`${baseUrl}/`); } },
        { label: '저장 폴더 열기', click: () => { void shell.openPath(join(dataDir, 'Drawings')); } },
        { type: 'separator' }, { role: 'quit' },
      ] },
    ]));
    await shell.openExternal(browserAccess.launchUrl(baseUrl));
    console.log(`SiteCAD 로컬 웹앱 실행 중: ${baseUrl}/`);
    console.log('브라우저 탭을 닫아도 실행기는 유지됩니다. 화면의 실행기 종료 또는 Dock의 SiteCAD 종료를 사용하세요.');
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640, title: 'SiteCAD', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' && !target.username && !target.password) void shell.openExternal(target.href).catch(() => {});
    } catch { /* Invalid reference URLs are ignored. */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `${baseUrl}/`) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  // The native close dialog already asked the user before the editor's beforeunload guard runs.
  mainWindow.webContents.on('will-prevent-unload', event => { if (closing) event.preventDefault(); });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const suggested = item.getFilename().replace(/[^\p{L}\p{N}_. -]/gu, '_');
    if (!/\.dwg$/i.test(suggested)) { event.preventDefault(); return; }
    // Chromium owns the Blob bytes; use its native Save As flow without granting renderer filesystem access.
    item.setSaveDialogOptions({ title: 'DWG 도면 저장', defaultPath: join(app.getPath('documents'), suggested), filters: [{ name: 'AutoCAD DWG', extensions: ['dwg'] }] });
  });
  mainWindow.on('close', confirmClose);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'SiteCAD', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'togglefullscreen' }] },
    { label: '윈도우', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
  await mainWindow.loadURL(`${baseUrl}/`);
}

if (primary) {
  app.on('second-instance', (_event, argv) => {
    if (browserMode && baseUrl) void shell.openExternal(`${baseUrl}/`);
    else if (argv.includes('--browser')) dialog.showErrorBox('SiteCAD 실행 중', '기존 SiteCAD 앱을 종료한 뒤 로컬 웹앱 실행 파일을 다시 열어 주세요.');
    else { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); }
  });
  app.on('activate', () => { if (browserMode && baseUrl) void shell.openExternal(`${baseUrl}/`); });
  app.on('before-quit', event => { if ((mainWindow || browserMode) && !closing) void confirmClose(event); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
  app.on('window-all-closed', () => { if (closing) app.quit(); });
  app.whenReady().then(start).catch(async () => {
    await closeServices();
    dialog.showErrorBox('SiteCAD 실행 오류', '로컬 실행 환경을 준비하지 못했습니다. 설치 파일의 무결성과 macOS 키체인 상태를 확인한 뒤 다시 실행해 주세요.');
    closing = true;
    app.quit();
  });
}
