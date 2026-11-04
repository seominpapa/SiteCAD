import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const latestUrl = 'https://api.github.com/repos/seominpapa/SiteCAD/releases/latest';
const releaseBase = 'https://github.com/seominpapa/SiteCAD/releases/download/';
const maxInstallerSize = 1024 * 1024 * 1024;
const headers = Object.freeze({ 'User-Agent': 'SiteCAD-Desktop-Updater', Accept: 'application/octet-stream' });
const failure = () => Error('업데이트 파일을 확인하지 못했습니다. 현재 버전을 계속 사용할 수 있습니다.');

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value)) throw failure();
  return value.split('.').map(Number);
}

export function updateFromRelease(release, { currentVersion, platform, arch }) {
  const current = versionParts(currentVersion);
  if (!(platform === 'win32' && arch === 'x64' || platform === 'darwin' && arch === 'arm64')) throw failure();
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw failure();
  if (release.draft === true || release.prerelease === true) return null;
  if (release.draft !== false || release.prerelease !== false) throw failure();
  if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return null;
  const version = release.tag_name.slice(1), next = versionParts(version);
  const different = next.findIndex((part, index) => part !== current[index]);
  if (different === -1 || next[different] < current[different]) return null;
  const name = `SiteCAD-${version}-${platform === 'win32' ? 'Windows-x64-Setup.exe' : 'macOS-arm64.dmg'}`;
  const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name) : [];
  if (assets.length !== 1) throw failure();
  const asset = assets[0], url = `${releaseBase}v${version}/${name}`;
  if (asset.state !== 'uploaded' || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxInstallerSize) throw failure();
  return Object.freeze({ version, name, url, sha256: asset.digest.slice(7), size: asset.size });
}

async function installerResponse(url, { fetchImpl, signal }) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || target.href.length > 16384 ||
        !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw failure();
    const response = await fetchImpl(target.href, { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw failure();
    url = new URL(location, target).href;
  }
  throw failure();
}

export async function downloadUpdate(update, { directory, fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  versionParts(update.version);
  if (!/^SiteCAD-\d+\.\d+\.\d+-(Windows-x64-Setup\.exe|macOS-arm64\.dmg)$/.test(update.name ?? '') ||
      update.url !== `${releaseBase}v${update.version}/${update.name}` || !/^[a-f0-9]{64}$/.test(update.sha256 ?? '') ||
      !Number.isSafeInteger(update.size) || update.size <= 0 || update.size > maxInstallerSize) throw failure();
  const file = join(directory, update.name);
  const timeout = AbortSignal.timeout(15 * 60 * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let fileCreated = false;
  try {
    const response = await installerResponse(update.url, { fetchImpl, signal: combined });
    if (!response.ok || !response.body) throw failure();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== update.size)) { await response.body.cancel(); throw failure(); }
    let received = 0;
    const digest = createHash('sha256');
    const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    output.once('open', () => { fileCreated = true; });
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > update.size) return callback(failure());
        digest.update(chunk);
        onProgress(received / update.size);
        callback(null, chunk);
      },
    }), output, { signal: combined });
    if (received !== update.size || digest.digest('hex') !== update.sha256) throw failure();
    onProgress(1);
    return file;
  } catch (cause) {
    if (fileCreated) await rm(file, { force: true });
    throw cause;
  }
}

async function latestRelease(fetchImpl, signal) {
  const response = await fetchImpl(latestUrl, { headers: { ...headers, Accept: 'application/vnd.github+json' }, redirect: 'error', signal });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 1024 * 1024) throw failure();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw failure();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createDesktopUpdater({ currentVersion, platform, arch, updatesDir, fetchImpl = fetch,
  showMessage, prepareInstall, install, onProgress = () => {}, isClosing = () => false, canInstall = async () => {},
}) {
  let busy = false, active, settled;
  return {
    async cancel() { active?.abort(); await settled; },
    async check({ manual = false } = {}) {
      if (busy || isClosing()) return { status: 'busy' };
      busy = true;
      active = new AbortController();
      let finish;
      settled = new Promise(resolve => { finish = resolve; });
      let directory, prepared, handedOff = false, prompted = false;
      try {
        const signal = active.signal;
        const release = await latestRelease(fetchImpl, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
        const update = updateFromRelease(release, { currentVersion, platform, arch });
        if (isClosing() || signal.aborted) return { status: 'cancelled' };
        if (!update) {
          if (manual) await showMessage({ type: 'info', title: 'SiteCAD 업데이트', message: `현재 버전 ${currentVersion}은 최신 버전입니다.`, buttons: ['확인'] });
          return { status: 'current' };
        }
        prompted = true;
        const consent = await showMessage({ type: 'info', title: 'SiteCAD 업데이트',
          message: `새 버전 ${update.version}이 있습니다.`, detail: `현재 버전: ${currentVersion}\n설치 파일을 다운로드할까요? 다운로드 중에는 작업을 계속할 수 있습니다. 설치 전 도면 저장과 앱 종료를 다시 확인합니다.`,
          buttons: ['나중에', '다운로드'], defaultId: 0, cancelId: 0 });
        if (consent.response !== 1 || isClosing() || signal.aborted) return { status: 'declined' };
        await mkdir(updatesDir, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(updatesDir, 'download-'));
        onProgress(0);
        const file = await downloadUpdate(update, { directory, fetchImpl, onProgress, signal });
        onProgress(-1);
        if (isClosing() || signal.aborted) return { status: 'cancelled' };
        const confirmation = await showMessage({ type: 'warning', title: 'SiteCAD 업데이트 설치',
          message: `버전 ${update.version} 다운로드가 완료됐습니다.`,
          detail: '저장하지 않은 도면 변경은 사라집니다. 필요한 도면을 DWG로 저장한 뒤 설치해 주세요. 진행 중인 AI 작업도 중단됩니다. 기존 도면 폴더와 사용자 설정은 삭제하지 않습니다.',
          buttons: ['계속 작업', '앱 종료 후 설치'], defaultId: 0, cancelId: 0 });
        if (confirmation.response !== 1 || isClosing() || signal.aborted) return { status: 'deferred' };
        onProgress(2);
        if (await canInstall() === false) return { status: 'blocked' };
        prepared = await prepareInstall({ file, version: update.version });
        if (isClosing() || signal.aborted) return { status: 'cancelled' };
        if (await canInstall() === false) return { status: 'blocked' };
        if (isClosing() || signal.aborted) return { status: 'cancelled' };
        await install(prepared);
        handedOff = true;
        return { status: 'installing', version: update.version };
      } catch {
        if (!isClosing() && !active.signal.aborted && (manual || prompted)) await showMessage({ type: 'error', title: 'SiteCAD 업데이트',
          message: '업데이트를 완료하지 못했습니다.', detail: '현재 앱과 도면·설정은 유지됩니다. 인터넷 연결, 저장 공간과 앱 설치 위치의 쓰기 권한을 확인해 주세요. Mac은 DMG 안에서 실행하지 말고 응용 프로그램 폴더에 설치해야 합니다. 필요하면 GitHub 릴리스에서 설치 파일을 받아 수동으로 설치해 주세요.', buttons: ['확인'] });
        return { status: 'failed' };
      } finally {
        onProgress(-1);
        if (!handedOff) {
          const results = await Promise.allSettled([prepared?.cleanup(), directory && rm(directory, { recursive: true, force: true })]);
          if (results.some(result => result.status === 'rejected')) console.warn('SiteCAD 업데이트 임시 파일 정리에 실패했습니다.');
        }
        busy = false;
        active = undefined;
        finish();
        settled = undefined;
      }
    },
  };
}
