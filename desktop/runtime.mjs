import { copyFile, mkdir, readFile, rename, rm, chmod, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileSha256, verifyCodexInstallation } from '../scripts/install-codex.mjs';
import { createNodeSecretStores } from '../lib/node-secret-store.mjs';

export function desktopPaths(dataDir) {
  if (!isAbsolute(dataDir)) throw Error('SiteCAD data path must be absolute');
  return {
    codexHome: join(dataDir, 'codex-home'),
    workspace: join(dataDir, 'workspace'),
    runtime: join(dataDir, 'runtime'),
    secrets: join(dataDir, 'credentials.enc'),
  };
}

export async function drawingFolderInBundle(bundle, drawings) {
  const [appPath, drawingPath] = await Promise.all([realpath(bundle), realpath(drawings)]);
  const path = relative(appPath, drawingPath);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function isAllowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname);
  } catch { return false; }
}

export function skillShareDownload(name, url, base) {
  return /^SiteCAD-skills-\d+\.\d+\.\d+-\d{8}\.zip$/.test(name) && typeof url === 'string' && url.startsWith(`blob:${base}/`);
}

const stages = {
  profile: '사용자 데이터 폴더 준비', runtime: '내장 실행 파일 확인·설치',
  settings: '로그인·설정 불러오기', server: '로컬 서버 시작', window: '앱 화면 열기',
};

export function credentialFailure(code, platform = process.platform) {
  const system = platform === 'win32' ? 'Windows 계정 암호화 저장소(DPAPI)' : platform === 'darwin' ? 'macOS 로그인 키체인' : '운영체제 암호화 저장소';
  const reason = code === 'SITECAD_ENCRYPTION_UNAVAILABLE' ? `${system}를 사용할 수 없습니다.`
    : code === 'SITECAD_CREDENTIALS_DECRYPT' ? `${system}에서 기존 인증정보를 복호화하지 못했습니다.` : '인증정보 파일에 접근하지 못했습니다.';
  return Object.assign(Error(`${reason} 기존 파일을 보존하고, 저장할 때 사용한 운영체제 계정과 데이터 폴더 접근 권한을 확인해 주세요.`), { code });
}

export function startupFailure({ error, stage, platform = process.platform, version }) {
  const phase = Object.hasOwn(stages, stage) ? stage : 'unknown';
  const runtimeCode = phase !== 'runtime' ? undefined
    : error?.message === 'Bundled Codex integrity check failed' ? 'SITECAD_RUNTIME_INTEGRITY'
    : error?.message === 'Codex Windows binary architecture is invalid' ? 'SITECAD_RUNTIME_ARCH'
    : /^Bundled Codex (?:version, platform or architecture is|files are|machine is|package metadata is) invalid$/.test(error?.message ?? '') ? 'SITECAD_RUNTIME_INVALID'
    : error instanceof SyntaxError ? 'SITECAD_RUNTIME_MANIFEST' : undefined;
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : runtimeCode ?? 'UNKNOWN';
  const credential = ['SITECAD_ENCRYPTION_UNAVAILABLE', 'SITECAD_CREDENTIALS_DECRYPT', 'SITECAD_CREDENTIALS_READ'].includes(code);
  const guidance = credential ? credentialFailure(code, platform).message
    : phase === 'runtime' ? `내장 실행 파일과 설치 폴더 접근 권한${platform === 'win32' ? ', Windows 보안의 보호 기록에서 차단된 파일이 있는지' : ''}를 확인해 주세요.`
    : '설치 파일과 사용자 데이터 폴더 접근 권한을 확인해 주세요. 기존 도면·설정·인증정보는 삭제하지 마세요.';
  return {
    message: `SiteCAD ${version} 실행을 마치지 못했습니다.\n실패 단계: ${stages[phase] ?? '시작 준비'}\n오류 코드: ${code}\n\n${guidance}`,
    // Only bounded identifiers are recorded; raw exceptions can contain credentials or user content.
    diagnostic: { version, platform, stage: phase, code, recordedAt: new Date().toISOString() },
  };
}

export async function saveStartupFailure(file, diagnostic) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
}

export function createSecureStore({ file, safeStorage, platform = process.platform }) {
  function requireKeychain() {
    if (!safeStorage.isEncryptionAvailable()) throw credentialFailure('SITECAD_ENCRYPTION_UNAVAILABLE', platform);
  }
  return {
    async read() {
      let encrypted;
      try { encrypted = await readFile(file); }
      catch (cause) { if (cause.code === 'ENOENT') return null; throw credentialFailure('SITECAD_CREDENTIALS_READ', platform); }
      requireKeychain();
      try { return JSON.parse(safeStorage.decryptString(encrypted)); }
      catch { throw credentialFailure('SITECAD_CREDENTIALS_DECRYPT', platform); }
    },
    async write(value) {
      requireKeychain();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    },
    async remove() { await rm(file, { force: true }); },
  };
}

export function createDesktopSecretStores({ dataDir, safeStorage, platform = process.platform, entry }) {
  const legacyStore = name => createSecureStore({ file: join(dataDir, name), safeStorage, platform });
  // Windows Chromium's first key can be lost on forced exit; persist the OS credential before ciphertext.
  if (platform === 'win32') return createNodeSecretStores({ dataDir, entry, platform, service: 'SiteCAD Desktop', legacyStore });
  return Object.fromEntries(Object.entries({ auth: 'credentials.enc', mcp: 'mcp-secrets.enc', references: 'vworld-secrets.enc', llm: 'llm-secrets.enc', apis: 'api-secrets.enc' })
    .map(([key, name]) => [key, legacyStore(name)]));
}

export async function installBundledCodex({ sourceDir, destination, arch = process.arch, platform = process.platform }) {
  await verifyCodexInstallation(sourceDir, { arch, platform });
  const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'));
  const root = dirname(destination);
  const files = manifest.files || { codex: manifest.sha256 };
  // Install the entrypoint last so a failed helper copy leaves the existing runtime executable intact.
  const entrypoint = manifest.entrypoint || 'codex';
  const names = [...Object.keys(files).filter(name => name !== entrypoint), entrypoint];
  for (const name of names) {
    const target = platform === 'win32' ? join(root, name) : destination;
    if (await fileSha256(target).catch(() => null) === files[name]) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(join(sourceDir, name), temporary);
      await chmod(temporary, 0o700);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return platform === 'win32' ? join(root, entrypoint) : destination;
}
