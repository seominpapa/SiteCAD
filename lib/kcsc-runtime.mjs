import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedProcessEnv, stopProcessTree } from './mcp-launcher.mjs';

export const KCSC_VERSION = '0.3.1';
export const KCSC_PYTHON_VERSION = '3.12.11';
const UV_VERSION = '0.8.22';
const lockPath = fileURLToPath(new URL('./kcsc-requirements.lock', import.meta.url));
const assets = {
  'darwin-arm64': ['d7/ca/bf37d86af6e16e45fa2b1a03300784ff3297aa9252a23dfbeaf6e391e72e', 'macosx_11_0_arm64', '6706b782ad75662df794e186d16b9ffa4946d57c88f21d0eadfd43425794d1b0'],
  'darwin-x64': ['28/e9/813f7eb9fb9694c4024362782c8933e37887b5195e189f80dc40f2da5958', 'macosx_10_12_x86_64', '89944e99b04cc8542cb5931306f1c593f00c9d6f2b652fffc4d84d12b915f911'],
  'win32-x64': ['38/82/94f08992eeb193dc3d5baac437d1867cd37f040f34c7b1a4b1bde2bc4b4b', 'win_amd64', 'cda349c9ea53644d8d9ceae30db71616b733eb5330375ab4259765aef494b74e'],
  'win32-arm64': ['f9/00/2c7a93bbe93b74dc0496a8e875bac11027cb30c29636c106c6e49038b95f', 'win_arm64', '2a436b941b6e79fe1e1065b705a5689d72210f4367cbe885e19910cbcde2e4a1'],
};
export const kcscFailure = message => Object.assign(Error(message ?? 'KCSC 설치 또는 연결에 실패했습니다. 키·서비스 권한·네트워크를 확인해 주세요.'), { sitecadSafe: true });
const aborted = signal => { if (signal?.aborted) throw kcscFailure('KCSC 설치·연결을 취소했습니다.'); };

export function kcscTarget({ platform = process.platform, arch = process.arch } = {}) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw kcscFailure('KCSC 자동 설치는 macOS·Windows의 Intel/AMD64·ARM64 환경을 지원합니다.');
  const [path, tag, sha256] = asset;
  return { url: `https://files.pythonhosted.org/packages/${path}/uv-${UV_VERSION}-py3-none-${tag}.whl`, sha256,
    member: `uv-${UV_VERSION}.data/scripts/uv${platform === 'win32' ? '.exe' : ''}` };
}

export function runKcscProcess(command, args, { cwd, env, signal, maxBuffer = 1024 * 1024, timeoutMs = 240000 } = {}) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false, failure, bytes = 0;
    const chunks = [];
    const terminate = error => {
      if (failure || settled) return;
      failure = error; stopProcessTree(child, 'SIGTERM', { killGroup: true });
      setTimeout(() => stopProcessTree(child, 'SIGKILL', { killGroup: true }), 1500).unref();
    };
    const cancel = () => terminate(kcscFailure('KCSC 설치·연결을 취소했습니다.'));
    const timer = setTimeout(() => terminate(kcscFailure('KCSC 설치 제한 시간을 초과했습니다. 다시 시도해 주세요.')), timeoutMs);
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve({ stdout: Buffer.concat(chunks) });
    };
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) terminate(kcscFailure()); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) terminate(kcscFailure()); });
    child.once('error', () => finish(kcscFailure()));
    child.once('close', code => finish(failure ?? (code === 0 ? undefined : kcscFailure())));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function safeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw kcscFailure('KCSC 설치 경로를 확인해 주세요.');
}

async function downloadUv(target, destination, fetchImpl, signal) {
  const response = await fetchImpl(target.url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 64 * 1024 * 1024) throw kcscFailure();
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw kcscFailure();
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (createHash('sha256').update(buffer).digest('hex') !== target.sha256) throw kcscFailure('KCSC 설치 파일의 무결성 검증에 실패했습니다.');
  await writeFile(destination, buffer, { mode: 0o600, flag: 'wx' });
}

export function createKcscInstaller({ dataDir, platform = process.platform, arch = process.arch, fetchImpl = fetch, execute = runKcscProcess } = {}) {
  if (!isAbsolute(dataDir ?? '')) throw kcscFailure();
  const root = join(dataDir, 'mcp-runtime', 'kcsc');
  const python = directory => join(directory, 'venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const descriptor = directory => ({ command: python(directory), args: ['-I', '-m', 'kcsc_mcp'] });
  const marker = join(root, 'installation.json');
  const lockHash = async () => createHash('sha256').update(await readFile(lockPath)).digest('hex');
  const status = async () => {
    try {
      const value = JSON.parse(await readFile(marker, 'utf8'));
      if (value.version !== KCSC_VERSION || value.python !== KCSC_PYTHON_VERSION || value.platform !== platform || value.arch !== arch || value.lock !== await lockHash() || !/^[a-f0-9-]{36}$/.test(value.directory)) return { installed: false };
      const directory = join(root, value.directory);
      const command = python(directory); const target = await realpath(command);
      const inside = relative(await realpath(root), target);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(await lstat(target)).isFile()) return { installed: false };
      return { installed: true, ...descriptor(directory) };
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { installed: false }; throw kcscFailure(); }
  };
  return {
    status,
    async install({ signal } = {}) {
      const existing = await status(); if (existing.installed) return existing;
      const target = kcscTarget({ platform, arch }); aborted(signal);
      await safeDirectory(dataDir); await safeDirectory(dirname(root)); await safeDirectory(root);
      const directory = join(root, randomUUID()); await safeDirectory(directory);
      const home = join(directory, 'home'); await safeDirectory(home);
      const uvPath = join(directory, platform === 'win32' ? 'uv.exe' : 'uv');
      const env = { ...isolatedProcessEnv(home, uvPath, { platform }), UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1', UV_NO_CONFIG: '1', UV_INDEX_URL: 'https://pypi.org/simple', UV_PYTHON_DOWNLOADS: 'automatic' };
      try {
        const archive = join(directory, 'uv.zip'); await downloadUv(target, archive, fetchImpl, signal);
        const tar = platform === 'win32' ? join(env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar';
        // A verified wheel is a ZIP; bsdtar reads just this fixed member, never archive paths or links.
        const { stdout } = await execute(tar, ['-xOf', archive, target.member], { cwd: directory, env, signal, maxBuffer: 96 * 1024 * 1024 });
        if (!stdout.length || stdout.length > 90 * 1024 * 1024) throw kcscFailure();
        await writeFile(uvPath, stdout, { mode: 0o700, flag: 'wx' }); await chmod(uvPath, 0o755);
        for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
          const { stdout: license } = await execute(tar, ['-xOf', archive, `uv-${UV_VERSION}.dist-info/licenses/${name}`], { cwd: directory, env, signal });
          if (!license.length) throw kcscFailure();
          await writeFile(join(directory, `uv-${name}`), license, { mode: 0o600, flag: 'wx' });
        }
        const runUv = args => execute(uvPath, ['--no-config', '--native-tls', ...args], { cwd: directory, env, signal });
        await runUv(['python', 'install', KCSC_PYTHON_VERSION]);
        await runUv(['venv', '--python', KCSC_PYTHON_VERSION, join(directory, 'venv')]);
        await runUv(['pip', 'sync', '--python', python(directory), '--require-hashes', '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple', lockPath]);
        const { stdout: versions } = await execute(python(directory), ['-I', '-c', 'import sys,importlib.metadata; print(".".join(map(str,sys.version_info[:3]))); print(importlib.metadata.version("kcsc-design-mcp"))'], { cwd: directory, env, signal });
        if (versions.toString('utf8').replace(/\r\n/g, '\n').trim() !== `${KCSC_PYTHON_VERSION}\n${KCSC_VERSION}`) throw kcscFailure();
        aborted(signal);
        const temporary = `${marker}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: KCSC_VERSION, python: KCSC_PYTHON_VERSION, platform, arch, lock: await lockHash(), directory: directory.split(sep).at(-1) }), { mode: 0o600, flag: 'wx' });
        await rm(archive, { force: true }); await rename(temporary, marker);
        return { installed: true, ...descriptor(directory) };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if (signal?.aborted) throw kcscFailure('KCSC 설치·연결을 취소했습니다.');
        throw error.sitecadSafe ? error : kcscFailure();
      }
    },
  };
}
