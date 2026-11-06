import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import { mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createDesktopSecretStores, desktopPaths, installBundledCodex, isAllowedAuthUrl, drawingFolderInBundle, skillShareDownload, startupFailure, saveStartupFailure } from './runtime.mjs';
import { createBrowserAccess } from '../lib/browser-access.mjs';
import { createDesktopUpdater } from './updater.mjs';
import { prepareUpdateInstall } from './update-install.mjs';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const browserMode = process.argv.includes('--browser');
app.setName('SiteCAD');
// Different Electron signatures must never overwrite the installed app's encrypted credentials.
app.setPath('userData', join(app.getPath('appData'), browserMode ? 'SiteCAD Local Web' : 'SiteCAD'));
let mainWindow;
let server;
let controller;
let closing = false;
let exitReady = false;
let closingPrompt = false;
let baseUrl;
let updater;
let updateHandoff = false;
let updateScheduled = false;
let startupStage = 'profile';
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

async function closeServices() {
  // The handoff itself runs inside the updater; only ordinary shutdown can join it.
  if (updateHandoff) void updater?.cancel();
  else await updater?.cancel();
  await controller?.close().catch(() => {});
  if (server) await new Promise(resolveClose => {
    server.close(resolveClose);
    server.closeAllConnections();
  });
}

async function confirmClose(event) {
  if (exitReady) return;
  event.preventDefault();
  if (closing || closingPrompt || updateHandoff) return;
  closingPrompt = true;
  try {
    const options = {
      type: 'warning', buttons: ['계속 작업', '종료'], defaultId: 0, cancelId: 0,
      title: 'SiteCAD 종료', message: '저장하지 않은 도면 변경은 사라집니다.',
      detail: '필요한 도면을 DWG로 저장한 뒤 종료해 주세요. 진행 중인 AI 작업·ZIP 내보내기·개선안 제출도 중단될 수 있습니다.',
    };
    const result = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
    if (result.response !== 1) return;
    closing = true;
    await closeServices();
    exitReady = true;
    app.quit();
  } finally { closingPrompt = false; }
}

async function updateMessage(options) {
  if (closing || closingPrompt || updateHandoff) return { response: options.cancelId ?? 0 };
  closingPrompt = true;
  try { return await dialog.showMessageBox(mainWindow, options); }
  finally { closingPrompt = false; }
}

function startUpdater(dataDir) {
  if (!app.isPackaged || browserMode) return;
  const executable = app.getPath('exe'), updatesDir = join(dataDir, 'updates');
  updater = createDesktopUpdater({ currentVersion: app.getVersion(), platform: process.platform, arch: process.arch, updatesDir,
    showMessage: updateMessage,
    isClosing: () => closing || updateHandoff,
    onProgress: value => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value); },
    canInstall: async () => {
      const state = await controller.status();
      if (state.active || state.busy) {
        await updateMessage({ type: 'warning', title: '작업 완료 후 설치', message: '진행 중인 작업을 마친 뒤 업데이트를 다시 시도해 주세요.', buttons: ['확인'] });
        return false;
      }
      if (process.platform === 'darwin' && await drawingFolderInBundle(resolve(dirname(executable), '../..'), await controller.drawingDirectory())) {
        await updateMessage({ type: 'warning', title: '도면 저장 위치 변경 필요', message: '선택한 도면 폴더가 앱 내부에 있습니다.',
          detail: '도면과 보조 파일을 앱 바깥으로 옮기고 설정에서 새 저장 폴더를 선택한 다음 업데이트해 주세요. 도면 보호를 위해 설치를 중단했습니다.', buttons: ['확인'] });
        return false;
      }
      return true;
    },
    prepareInstall: ({ file, version }) => prepareUpdateInstall({ file, version, executable, updatesDir }),
    install: async prepared => {
      updateHandoff = true;
      try {
        await prepared.install();
        closing = true;
        await closeServices();
        exitReady = true;
        app.quit();
      } finally { updateHandoff = false; }
    },
  });
  void updater.check().catch(() => console.warn('SiteCAD 업데이트 확인을 마치지 못했습니다. 현재 앱은 계속 사용할 수 있습니다.'));
}

const updateActions = {
  status: () => ({ ...(updater?.status() ?? { supported: false, kind: 'desktop', currentVersion: app.getVersion(), status: 'unchecked', busy: false }), ...(updateScheduled ? { busy: true, status: 'scheduled' } : {}) }),
  async check() {
    if (updater) await updater.check({ notify: false });
    return updateActions.status();
  },
  async install() {
    if (!updater || updateScheduled || updater.status().busy || !updater.status().availableVersion || closing || updateHandoff) throw Error('작업을 마친 뒤 업데이트를 다시 확인해 주세요.');
    updateScheduled = true;
    setTimeout(() => { updateScheduled = false; void updater.check({ manual: true }); }, 100);
    return updateActions.status();
  },
};

async function openTestDrawings() {
  try {
    if (await shell.openPath(join(appRoot, 'drawings', 'Test'))) throw Error('Sample folder unavailable');
  } catch { dialog.showErrorBox('테스트 도면', '테스트 도면 폴더를 열지 못했습니다. 설치 파일의 무결성과 폴더 접근 권한을 확인해 주세요.'); }
}

async function start() {
  const dataDir = app.getPath('userData');
  const paths = desktopPaths(dataDir);
  for (const directory of [paths.codexHome, paths.workspace, paths.runtime]) await mkdir(directory, { recursive: true, mode: 0o700 });
  startupStage = 'runtime';
  const codexPath = await installBundledCodex({ sourceDir: join(appRoot, 'runtime'), destination: join(paths.runtime, 'codex') });
  startupStage = 'settings';
  const secretStores = createDesktopSecretStores({ dataDir, safeStorage });
  controller = await createDesktopController({
    dataDir, defaultDrawingsPath: join(app.isPackaged ? (process.platform === 'darwin' ? resolve(app.getPath('exe'), '../../../..') : dirname(app.getPath('exe'))) : appRoot, 'drawings'),
    codexPath, nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    secureStore: secretStores.auth,
    mcpSecretStore: secretStores.mcp,
    referenceSecretStore: secretStores.references,
    llmSecretStore: secretStores.llm,
    apiSecretStore: secretStores.apis,
    selectDrawingsFolder: async ({ defaultPath }) => {
      const options = { title: '도면 저장 폴더 선택', defaultPath, properties: ['openDirectory', 'createDirectory'] };
      const selection = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
      return selection.canceled ? null : selection.filePaths[0];
    },
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
  startupStage = 'server';
  const bundledFixture = join(appRoot, 'fixtures', 'retaining-wall.dwg');
  const fixturePath = await stat(bundledFixture).then(info => info.isFile()).catch(() => false)
    ? bundledFixture : join(appRoot, '../rhino-experiments/retaining-wall-20261020/retaining-wall-drawing-2d.dwg');
  const browserAccess = browserMode ? createBrowserAccess() : undefined;
  server = createApp({ desktop: controller, fixturePath, browserAccess, updates: updateActions, browserActions: {
    openDrawings: async () => { const message = await shell.openPath(await controller.drawingDirectory()); if (message) throw Error('저장 폴더를 열지 못했습니다.'); },
    quit: async () => { setImmediate(() => { void confirmClose({ preventDefault() {} }).catch(() => {}); }); },
  } });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await controller.start({ baseUrl });
  startupStage = 'window';
  if (browserMode) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'SiteCAD', submenu: [
        { label: '브라우저에서 열기', click: () => { void shell.openExternal(`${baseUrl}/`); } },
        { label: '저장 폴더 열기', click: () => { void controller.drawingDirectory().then(path => shell.openPath(path)).catch(() => dialog.showErrorBox('저장 폴더', '설정에서 저장 폴더와 접근 권한을 확인해 주세요.')); } },
        { label: '테스트 도면 폴더 열기', click: () => { void openTestDrawings(); } },
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
    if (skillShareDownload(suggested, item.getURL(), baseUrl)) {
      item.setSaveDialogOptions({ title: '스킬 개선안 ZIP 저장', defaultPath: join(app.getPath('downloads'), suggested), filters: [{ name: '스킬 ZIP', extensions: ['zip'] }] });
      return;
    }
    if (!/\.dwg$/i.test(suggested)) { event.preventDefault(); return; }
    // Chromium owns the Blob bytes; use its native Save As flow without granting renderer filesystem access.
    item.setSaveDialogOptions({ title: 'DWG 도면 저장', defaultPath: join(controller.storageStatus().path, suggested), filters: [{ name: 'AutoCAD DWG', extensions: ['dwg'] }] });
  });
  mainWindow.on('close', confirmClose);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'SiteCAD', submenu: [{ role: 'about' }, { label: '업데이트 확인', enabled: app.isPackaged, click: () => { void updater?.check({ manual: true }).catch(() => console.warn('SiteCAD 업데이트 확인 실패')); } }, { label: '테스트 도면 폴더 열기', click: () => { void openTestDrawings(); } }, { type: 'separator' }, { role: 'quit' }] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'togglefullscreen' }] },
    { label: '윈도우', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
  await mainWindow.loadURL(`${baseUrl}/`);
  startUpdater(dataDir);
}

if (primary) {
  app.on('second-instance', (_event, argv) => {
    if (browserMode && baseUrl) void shell.openExternal(`${baseUrl}/`);
    else if (argv.includes('--browser')) dialog.showErrorBox('SiteCAD 실행 중', '기존 SiteCAD 앱을 종료한 뒤 로컬 웹앱 실행 파일을 다시 열어 주세요.');
    else { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); }
  });
  app.on('activate', () => { if (browserMode && baseUrl) void shell.openExternal(`${baseUrl}/`); });
  app.on('before-quit', event => { if ((mainWindow || browserMode) && !exitReady) void confirmClose(event); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
  app.on('window-all-closed', () => { if (exitReady) app.quit(); });
  app.whenReady().then(start).catch(async error => {
    const failure = startupFailure({ error, stage: startupStage, version: app.getVersion() });
    const logFile = join(app.getPath('userData'), 'diagnostics', 'startup-error.json');
    let detail;
    try { await saveStartupFailure(logFile, failure.diagnostic); detail = `진단 파일: ${logFile}`; }
    catch { detail = '진단 파일을 저장하지 못했습니다. 이 오류창의 실패 단계와 오류 코드를 전달해 주세요.'; }
    await closeServices().catch(() => {});
    dialog.showErrorBox('SiteCAD 실행 오류', `${failure.message}\n\n${detail}`);
    closing = true;
    exitReady = true;
    app.quit();
  });
}
