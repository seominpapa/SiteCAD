import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, writeFile, rm, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isolatedProcessEnv, stopProcessTree } from './mcp-launcher.mjs';

const MAX_METADATA = 1024 * 1024;
const PLAN_TTL = 10 * 60 * 1000;
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) && !['sitecad', 'research', 'constructor', 'prototype'].includes(value);
const validPackage = value => typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const fail = message => Object.assign(Error(message || 'MCP 설치를 완료하지 못했습니다. 기존 연결은 변경하지 않았습니다.'), { sitecadSafe: true });
const cancelled = signal => { if (signal?.aborted) throw fail('MCP 설치가 취소되었습니다.'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function githubSource(value) {
  if (typeof value !== 'string' || value.length > 2048 || /%(?:2e|2f|5c)/i.test(value)) throw fail('공개 GitHub 저장소 URL을 확인해 주세요.');
  let url;
  try { url = new URL(value); } catch { throw fail('공개 GitHub 저장소 URL을 확인해 주세요.'); }
  let parts;
  try { parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(part => decodeURIComponent(part)); } catch { throw fail('공개 GitHub 저장소 URL을 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || parts.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || parts.some(part => !part || part === '.' || part === '..' || /[\\/\x00-\x20]/.test(part))) throw fail('공개 GitHub 저장소 URL을 확인해 주세요.');
  if (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4)) throw fail('GitHub 저장소 또는 tree 경로를 사용해 주세요.');
  const owner = parts[0]; const repo = parts[1].replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..') throw fail('공개 GitHub 저장소 URL을 확인해 주세요.');
  return { owner, repo, ref: parts[3], path: parts.slice(4).join('/'), repository: `https://github.com/${owner}/${repo}` };
}

function repositoryIdentity(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url;
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/'));
    const parts = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '').split('/').filter(Boolean);
    if (url.hostname !== 'github.com' || parts.length !== 2) return undefined;
    return parts.join('/').toLowerCase();
  } catch { return undefined; }
}

function packageBin(manifest) {
  const entries = typeof manifest.bin === 'string' ? [[manifest.name.split('/').at(-1), manifest.bin]] : Object.entries(manifest.bin ?? {});
  const selected = entries.length === 1 ? entries[0] : entries.find(([key]) => key === manifest.name.split('/').at(-1));
  const path = typeof selected?.[1] === 'string' ? selected[1].replace(/^(?:\.\/)+/, '') : selected?.[1];
  if (typeof path !== 'string' || path.length > 512 || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.') || /[\x00-\x20:]/.test(path)) throw fail('이 패키지의 Node 실행 파일을 안전하게 선택할 수 없습니다.');
  return path;
}

async function metadata(fetchImpl, url, signal) {
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', headers: { Accept: new URL(url).hostname === 'api.github.com' ? 'application/vnd.github.raw+json' : 'application/json', 'User-Agent': 'SiteCAD-MCP-Installer' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }); }
  catch { cancelled(signal); throw fail('GitHub 또는 npm 패키지 정보를 조회하지 못했습니다.'); }
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_METADATA) throw fail('GitHub 또는 npm 패키지 정보를 확인할 수 없습니다. 공개 Node MCP 패키지만 지원합니다.');
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_METADATA) throw fail('MCP 패키지 정보가 허용 크기를 초과했습니다.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!plain(value)) throw fail();
    return value;
  }
  catch { throw fail('MCP 패키지 정보 형식이 올바르지 않습니다.'); }
}

async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('MCP 설치 경로를 확인해 주세요.');
}

async function npmCli(nodePath) {
  const binaries = [...new Set([nodePath, await realpath(nodePath).catch(() => nodePath)])];
  for (const executable of binaries) {
    for (const candidate of [join(dirname(executable), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
      try { if ((await lstat(candidate)).isFile()) return resolve(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      const adjacent = join(dirname(executable), 'npm');
      if ((await lstat(adjacent)).isSymbolicLink()) {
        const target = await realpath(adjacent);
        if (basename(target) === 'npm-cli.js' && (await lstat(target)).isFile()) return target;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw fail('이 SiteCAD 실행 환경에 npm이 없습니다. npm을 포함한 원클릭 로컬 웹 설치본을 사용해 주세요.');
}

function execute(command, args, options) {
  return new Promise((resolveProcess, reject) => {
    let child; let completed = false; let outputBytes = 0; let error;
    const finish = failure => { if (completed) return; completed = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); failure ? reject(failure) : resolveProcess(); };
    const terminate = failure => { if (error || completed) return; error = failure; stopProcessTree(child, 'SIGTERM', { killGroup: true }); setTimeout(() => stopProcessTree(child, 'SIGKILL', { killGroup: true }), 1500).unref(); };
    const abort = () => terminate(fail('MCP 설치가 취소되었습니다.'));
    child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => terminate(fail('MCP 패키지 설치 제한 시간을 초과했습니다.')), 180000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > MAX_METADATA) terminate(fail('MCP 설치 출력이 허용 크기를 초과했습니다.')); });
    child.once('error', () => finish(fail()));
    child.once('close', code => finish(error ?? (code === 0 ? undefined : fail())));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

async function installedBin(directory, plan) {
  const lockText = await readFile(join(directory, 'package-lock.json'), 'utf8');
  if (lockText.length > 4 * MAX_METADATA) throw fail('설치된 패키지 무결성을 확인하지 못했습니다.');
  const lock = JSON.parse(lockText); const locked = lock.packages?.[`node_modules/${plan.packageName}`];
  if (locked?.version !== plan.version || locked.integrity !== plan.integrity) throw fail('설치된 패키지 무결성을 확인하지 못했습니다.');
  const packageDir = join(directory, 'node_modules', plan.packageName);
  const bin = join(packageDir, plan.bin);
  for (const path of [join(packageDir, 'package.json'), bin]) {
    let current = directory;
    for (const part of relative(directory, path).split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw fail('MCP 실행 경로에 심볼릭 링크를 사용할 수 없습니다.');
    }
  }
  const manifestText = await readFile(join(packageDir, 'package.json'), 'utf8');
  if (manifestText.length > MAX_METADATA) throw fail();
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== plan.packageName || manifest.version !== plan.version || packageBin(manifest) !== plan.bin || !(await lstat(bin)).isFile() || !(await realpath(bin)).startsWith((await realpath(packageDir)) + sep)) throw fail('설치된 MCP 실행 파일을 확인하지 못했습니다.');
  if (!/\.[cm]?js$/.test(bin)) {
    const script = await open(bin, 'r'); const header = Buffer.alloc(256);
    try { await script.read(header, 0, header.length, 0); } finally { await script.close(); }
    if (!/^#![^\r\n]*\bnode\b/.test(header.toString('utf8'))) throw fail('Node MCP 실행 파일만 지원합니다.');
  }
  return bin;
}

function checkedInstall(input) {
  if (!plain(input) || Object.keys(input).some(key => !['planId', 'name', 'args'].includes(key)) || typeof input.planId !== 'string' || !validName(input.name)) throw fail('MCP 설치 이름과 요청을 확인해 주세요.');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || JSON.stringify(args).length > 16384 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f]/.test(arg))) throw fail('MCP 실행 인수를 확인해 주세요.');
  if (args.some(arg => /(?:^--(?:api[-_]?key|token|password|secret)(?:=|$)|^sk-|^gh[pousr]_|\bBearer\s)/i.test(arg))) throw fail('API 키와 비밀값은 채팅 인수 대신 /mcp 전용 입력 카드에서 등록해 주세요.');
  return { planId: input.planId, name: input.name, args: [...args] };
}

export function createMcpInstaller({ dataDir, nodePath, nodeEnv = {}, fetchImpl = fetch, runProcess = execute }) {
  if (!isAbsolute(dataDir ?? '') || !isAbsolute(nodePath ?? '') || Object.keys(nodeEnv).some(key => key !== 'ELECTRON_RUN_AS_NODE') || (nodeEnv.ELECTRON_RUN_AS_NODE !== undefined && nodeEnv.ELECTRON_RUN_AS_NODE !== '1')) throw fail('MCP 설치 환경이 올바르지 않습니다.');
  const root = join(dataDir, 'managed-mcp'); const plans = new Map();
  const remove = async id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('MCP 설치 식별자가 올바르지 않습니다.');
    await safeDirectory(dataDir); await safeDirectory(root);
    const target = join(root, id);
    try { if ((await lstat(target)).isSymbolicLink()) throw fail('MCP 설치 경로를 확인해 주세요.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(target, { recursive: true, force: true });
  };
  return {
    async inspect(url, { signal } = {}) {
      cancelled(signal);
      const source = githubSource(url); const base = `https://api.github.com/repos/${source.owner}/${source.repo}`;
      const repo = await metadata(fetchImpl, base, signal);
      const ref = source.ref ?? repo.default_branch;
      if (typeof ref !== 'string' || !ref || ref.length > 200) throw fail('GitHub 기본 브랜치를 확인하지 못했습니다.');
      const commit = await metadata(fetchImpl, `${base}/commits/${encodeURIComponent(ref)}`, signal);
      if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw fail('GitHub 원본 커밋을 확인하지 못했습니다.');
      const sourcePath = [source.path, 'package.json'].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
      const manifest = await metadata(fetchImpl, `${base}/contents/${sourcePath}?ref=${commit.sha}`, signal);
      if (!validPackage(manifest.name) || !manifest.bin) throw fail('현재 자동 설치는 npm에 배포된 Node MCP 실행 패키지만 지원합니다. 소스 빌드나 Python MCP는 직접 연결 설정이 필요합니다.');
      const published = await metadata(fetchImpl, `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/latest`, signal);
      if (published.name !== manifest.name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(published.version ?? '')) throw fail('npm 배포 패키지 버전을 확인하지 못했습니다.');
      if (repositoryIdentity(published.repository) !== `${source.owner}/${source.repo}`.toLowerCase()) throw fail('npm 패키지와 GitHub 원본 저장소가 일치하지 않습니다.');
      const integrity = published.dist?.integrity;
      if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) || Buffer.from(integrity.slice(7), 'base64').length !== 64) throw fail('패키지의 SHA-512 무결성 정보를 확인하지 못했습니다.');
      let tarball; try { tarball = new URL(published.dist?.tarball); } catch { throw fail('패키지 다운로드 주소가 올바르지 않습니다.'); }
      if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org' || tarball.port || tarball.username || tarball.password || tarball.search || tarball.hash || !tarball.pathname.endsWith('.tgz')) throw fail('패키지 다운로드 주소가 올바르지 않습니다.');
      const name = manifest.name.split('/').at(-1).replaceAll('.', '-').replaceAll('_', '-').slice(0, 40);
      const plan = { planId: randomUUID(), supported: true, name, repository: source.repository, sourceCommit: commit.sha, sourcePath: source.path, packageName: manifest.name, version: published.version, integrity, bin: packageBin(published), warning: '이 외부 MCP는 설치 후 사용자 계정 권한으로 실행되며 파일과 네트워크에 접근할 수 있습니다. 설치 스크립트는 실행하지 않습니다.' };
      for (const [id, entry] of plans) if (Date.now() - entry.created > PLAN_TTL) plans.delete(id);
      if (plans.size >= 20) plans.delete(plans.keys().next().value);
      plans.set(plan.planId, { plan, created: Date.now() });
      return structuredClone(plan);
    },
    async install(input, { approve, signal } = {}) {
      const clean = checkedInstall(input); cancelled(signal);
      const entry = plans.get(clean.planId);
      if (!entry || Date.now() - entry.created > PLAN_TTL) throw fail('설치 검토가 만료되었습니다. GitHub URL을 다시 조회해 주세요.');
      plans.delete(clean.planId);
      if (typeof approve !== 'function' || await approve(structuredClone({ ...entry.plan, name: clean.name, args: clean.args })) !== true) throw fail('MCP 설치가 승인되지 않았습니다.');
      cancelled(signal);
      const npm = await npmCli(nodePath);
      await safeDirectory(dataDir); await safeDirectory(root);
      const id = randomUUID(); const directory = join(root, id);
      await mkdir(directory, { mode: 0o700 });
      try {
        const userconfig = join(directory, 'npm-user.conf'); const globalconfig = join(directory, 'npm-global.conf');
        await writeFile(userconfig, '', { flag: 'wx', mode: 0o600 }); await writeFile(globalconfig, '', { flag: 'wx', mode: 0o600 });
        const env = { ...isolatedProcessEnv(directory, nodePath), ...nodeEnv, PATH: [dirname(nodePath), isolatedProcessEnv(directory, nodePath).PATH].join(process.platform === 'win32' ? ';' : ':'), TMPDIR: directory, GIT_CONFIG_NOSYSTEM: '1' };
        await runProcess(nodePath, [npm, 'install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=true', '--registry=https://registry.npmjs.org', `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`, `--cache=${join(directory, 'cache')}`, '--prefix', directory, `${entry.plan.packageName}@${entry.plan.version}`], { cwd: directory, env, signal });
        cancelled(signal);
        const bin = await installedBin(directory, entry.plan);
        return { config: { name: clean.name, transport: 'stdio', command: nodePath, args: [bin, ...clean.args], enabled: true }, installation: { id, path: directory, repository: entry.plan.repository, sourceCommit: entry.plan.sourceCommit, packageName: entry.plan.packageName, version: entry.plan.version, integrity: entry.plan.integrity, status: 'installed_pending_connection' } };
      } catch (error) {
        await remove(id);
        cancelled(signal);
        throw fail(error.sitecadSafe ? error.message : undefined);
      }
    },
    remove,
  };
}
