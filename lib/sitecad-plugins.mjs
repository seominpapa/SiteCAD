import { mkdir, lstat, open, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_TEXT = 256 * 1024, MAX_SKILL = 64 * 1024, TTL = 600000;
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const fail = message => Object.assign(Error(message), { sitecadSafe: true });
const cancelled = signal => { if (signal?.aborted) throw fail('플러그인 작업을 취소했습니다.'); };
const unsupported = () => fail('현재는 부속 파일 없이 SKILL.md만 사용하는 지침형 플러그인만 지원합니다. MCP·앱·훅·명령·에이전트·스크립트는 별도로 연결해 주세요.');
const pathParts = value => typeof value === 'string' && value.length <= 1024 && !/[\\\x00-\x20]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

function githubSource(value) {
  const invalid = () => fail('공개 GitHub 저장소 또는 tree URL을 확인해 주세요.');
  if (typeof value !== 'string' || value.length > 2048 || /%(?:2e|2f|5c)/i.test(value)) throw invalid();
  let url, parts;
  try { url = new URL(value); parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || parts.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || !pathParts(parts.join('/')) || parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4)) throw invalid();
  const repo = parts[1].replace(/\.git$/, ''); if (!repo || repo === '.' || repo === '..') throw invalid();
  return { repository: `https://github.com/${parts[0]}/${repo}`, base: `https://api.github.com/repos/${parts[0]}/${repo}`, raw: `https://raw.githubusercontent.com/${parts[0]}/${repo}`, ref: parts[3] ?? 'HEAD', root: parts.slice(4).join('/') };
}

async function fetchText(fetchImpl, url, limit, signal) {
  cancelled(signal);
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'SiteCAD-Plugin-Installer' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }); }
  catch { cancelled(signal); throw fail('GitHub 플러그인 정보를 조회하지 못했습니다.'); }
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) throw fail('플러그인 응답이나 파일 크기를 확인해 주세요.');
  const chunks = []; let bytes = 0;
  try { for await (const chunk of response.body) { cancelled(signal); bytes += chunk.length; if (bytes > limit) throw fail('플러그인 파일 크기 제한을 초과했습니다. 각 스킬은 64KiB, 합계는 256KiB 이하입니다.'); chunks.push(Buffer.from(chunk)); } }
  catch (error) { if (error.sitecadSafe) throw error; cancelled(signal); throw fail('GitHub 플러그인 원본을 끝까지 읽지 못했습니다.'); }
  return Buffer.concat(chunks).toString('utf8');
}

function json(raw) { try { const value = JSON.parse(raw); if (!plain(value)) throw Error(); return value; } catch { throw fail('플러그인 JSON 정보를 확인하지 못했습니다.'); } }
function skillDocument(raw, pluginName) {
  const match = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(raw);
  if (!match || raw.includes('\0')) throw fail('스킬의 단순 name·description 두 줄 형식을 확인해 주세요. 복잡한 YAML은 지원하지 않습니다.');
  const scalar = value => { if (value.startsWith('"')) return JSON.parse(value); if (/^[\[\]{}>|&*!'`#]/.test(value) || /\s#/.test(value)) throw Error(); return value; };
  let originalName, description;
  try { originalName = scalar(match[1]); description = scalar(match[2]); } catch { throw fail('스킬의 단순 name·description 형식을 확인해 주세요.'); }
  const name = `plugin-${pluginName}-${originalName}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(originalName ?? '') || name.length > 63 || typeof description !== 'string' || !description.trim() || description.length > 1024 || /[\r\n\0]/.test(description) || !match[3].trim()) throw fail('플러그인 스킬 이름·설명·본문을 확인해 주세요. 결합 이름은 63자 이하여야 합니다.');
  const body = match[3];
  if (/(?:^|[\s"'(])\.{1,2}\/|\b(?:scripts|references|assets|templates|examples)\/|\$\{[^}]*PLUGIN_ROOT\}/m.test(body) || [...body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].some(item => !/^(?:https?:\/\/|mailto:|#)/i.test(item[1]))) throw unsupported();
  const converted = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
  if (Buffer.byteLength(converted) > MAX_SKILL) throw fail('스킬은 변환된 이름·설명을 포함해 64KiB 이하여야 합니다.');
  return { name, description, body };
}

function selectedPaths(manifest) {
  const allowed = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills', 'interface'];
  if (Object.keys(manifest).some(key => !allowed.includes(key))) throw unsupported();
  if (!validName(manifest.name) || manifest.version !== undefined && (typeof manifest.version !== 'string' || !manifest.version || manifest.version.length > 80 || /[\x00-\x1f]/.test(manifest.version))) throw fail('플러그인 이름·버전을 확인해 주세요.');
  const paths = manifest.skills === undefined ? ['./skills'] : typeof manifest.skills === 'string' ? [manifest.skills] : manifest.skills;
  if (!Array.isArray(paths) || !paths.length || paths.length > 8) throw unsupported();
  return paths.map(path => {
    if (typeof path !== 'string') throw unsupported();
    const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
    if (!pathParts(normalized)) throw unsupported(); return normalized;
  });
}

function sourceFiles(tree, root, paths) {
  const prefix = root ? `${root}/` : '';
  const local = tree.filter(entry => entry.path.startsWith(prefix));
  for (const entry of local) {
    if (!pathParts(entry.path) || !['blob', 'tree'].includes(entry.type) || entry.type === 'blob' && !['100644', '100755'].includes(entry.mode)) throw fail('플러그인 경로에 링크나 서브모듈을 사용할 수 없습니다.');
    const path = entry.path.slice(prefix.length);
    if (/(?:^|\/)(?:\.?(?:mcp|apps?)\.json|hooks\.json|\.gitmodules|(?:hooks|apps|agents|commands)(?:\/|$))/i.test(path)) throw unsupported();
  }
  const scopes = paths.map(path => `${prefix}${path}`);
  const selected = local.filter(entry => entry.type === 'blob' && scopes.some(path => entry.path.startsWith(`${path}/`)));
  if (selected.some(entry => !/\/SKILL\.md$/.test(entry.path))) throw unsupported();
  if (scopes.some(scope => !selected.some(entry => entry.path.startsWith(`${scope}/`)))) throw fail('선언된 스킬 경로를 모두 확인하지 못했습니다. 부분 설치는 지원하지 않습니다.');
  if (!selected.length || selected.length > 8) throw fail('플러그인은 독립적인 SKILL.md 1~8개만 포함할 수 있습니다.');
  if (new Set(selected.map(item => item.path)).size !== selected.length) throw unsupported();
  return selected.sort((a, b) => a.path.localeCompare(b.path));
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('플러그인 저장 경로를 확인해 주세요.');
}

export function createSitecadPlugins({ dataDir, skills, fetchImpl = fetch }) {
  if (!isAbsolute(dataDir ?? '') || !skills?.save || !skills?.read || !skills?.remove) throw fail('플러그인 설치 환경을 확인해 주세요.');
  const file = join(dataDir, 'plugins.json'), plans = new Map(); let pending = Promise.resolve();
  const serialize = task => { const next = pending.then(task); pending = next.catch(() => {}); return next; };
  async function load() {
    await privateDirectory(dataDir);
    let info; try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TEXT) throw fail('플러그인 저장 경로·파일을 확인해 주세요.');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data; try { const current = await handle.stat(); if (!current.isFile() || current.size > MAX_TEXT) throw Error(); data = json(await handle.readFile('utf8')); } finally { await handle.close(); }
    if (data.version !== 1 || !Array.isArray(data.plugins) || data.plugins.length > 64 || data.plugins.some(item => !validName(item?.name) || item.version !== null && typeof item.version !== 'string' || !/^[a-f0-9]{40}$/.test(item.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(item.manifestSha256 ?? '') || !Array.isArray(item.skills) || !item.skills.length || item.skills.length > 8 || item.skills.some(skill => !/^plugin-[a-z0-9-]{1,56}$/.test(skill?.name ?? '') || !/^[a-f0-9]{64}$/.test(skill.hash ?? '') || !/^[a-f0-9]{64}$/.test(skill.sourceSha256 ?? '') || !pathParts(skill.sourcePath)))) throw fail('플러그인 저장 정보를 확인해 주세요.');
    if (new Set(data.plugins.map(item => item.name)).size !== data.plugins.length) throw fail('플러그인 저장 정보를 확인해 주세요.');
    return data.plugins;
  }
  async function store(items) {
    await privateDirectory(dataDir);
    try { if ((await lstat(file)).isSymbolicLink()) throw fail('플러그인 저장 경로를 확인해 주세요.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(dataDir, `.plugins-${randomUUID()}.tmp`);
    const raw = JSON.stringify({ version: 1, plugins: items });
    if (Buffer.byteLength(raw) > MAX_TEXT) throw fail('플러그인 저장 정보 크기를 초과했습니다. 기존 설치를 보존했습니다.');
    await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
    try { await rename(temporary, file); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  const metadata = (item, status) => ({ name: item.name, version: item.version, repository: item.repository, sourceCommit: item.sourceCommit, skills: item.skills.map(skill => skill.name), status });
  async function summary(item) {
    let status = 'installed';
    for (const skill of item.skills) {
      try { if ((await skills.read(skill.name)).hash !== skill.hash && status !== 'unavailable') status = 'modified'; }
      catch { status = 'unavailable'; }
    }
    return metadata(item, status);
  }
  async function inspected(url, { signal } = {}) {
    const source = githubSource(url);
    const commit = json(await fetchText(fetchImpl, `${source.base}/commits/${encodeURIComponent(source.ref)}`, 65536, signal));
    const treeSha = commit.commit?.tree?.sha;
    if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '') || !/^[a-f0-9]{40}$/.test(treeSha ?? '')) throw fail('플러그인 원본 커밋·트리를 확인하지 못했습니다.');
    const tree = json(await fetchText(fetchImpl, `${source.base}/git/trees/${treeSha}?recursive=1`, 2 * 1024 * 1024, signal));
    if (tree.sha !== treeSha || tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 20000 || tree.tree.some(entry => typeof entry?.path !== 'string')) throw fail('플러그인 파일 목록을 완전히 확인하지 못했습니다.');
    const prefix = source.root ? `${source.root}/` : '';
    const manifestPath = ['.codex-plugin/plugin.json', 'plugin.json', '.claude-plugin/plugin.json'].map(path => prefix + path).find(path => tree.tree.some(entry => entry.path === path));
    if (!manifestPath) throw unsupported();
    const blob = async entry => {
      if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha ?? '')) throw fail('플러그인 경로에 링크나 서브모듈을 사용할 수 없습니다.');
      const raw = await fetchText(fetchImpl, `${source.raw}/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, MAX_SKILL, signal);
      if (createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex') !== entry.sha) throw fail('플러그인 원본 파일 무결성을 확인하지 못했습니다.');
      return raw;
    };
    const manifestRaw = await blob(tree.tree.find(entry => entry.path === manifestPath)), manifest = json(manifestRaw);
    const entries = sourceFiles(tree.tree, source.root, selectedPaths(manifest));
    const documents = []; let total = Buffer.byteLength(manifestRaw);
    for (const entry of entries) {
      const raw = await blob(entry); total += Buffer.byteLength(raw);
      if (total > MAX_TEXT) throw fail('플러그인 원문 합계는 256KiB 이하여야 합니다.');
      documents.push({ ...skillDocument(raw, manifest.name), sourcePath: entry.path, sourceSha256: hash(raw) });
    }
    if (new Set(documents.map(item => item.name)).size !== documents.length) throw fail('플러그인 스킬 이름이 중복됩니다.');
    for (const [id, plan] of plans) if (plan.expiresAt < Date.now()) plans.delete(id);
    if (plans.size >= 20) plans.delete(plans.keys().next().value);
    const plan = { planId: randomUUID(), name: manifest.name, version: manifest.version ?? null, repository: source.repository, sourceCommit: commit.sha, manifestPath, manifestSha256: hash(manifestRaw), skills: documents, expiresAt: Date.now() + TTL };
    plans.set(plan.planId, plan);
    return { ...plan, skills: documents.map(({ body, ...item }) => item) };
  }
  function existing(items, name) {
    if (!validName(name)) throw fail('플러그인 이름을 확인해 주세요.');
    const item = items.find(value => value.name === name); if (!item) throw fail('설치된 플러그인을 찾지 못했습니다.'); return item;
  }
  async function rollback(created) {
    for (const item of [...created].reverse()) await skills.remove(item.name, item.hash);
  }
  return {
    inspect: inspected,
    async list() { await pending; return Promise.all((await load()).map(summary)); },
    async read(name) {
      await pending; const item = existing(await load(), name), result = await summary(item);
      const documents = await Promise.all(item.skills.map(async skill => { const current = await skills.read(skill.name); return { name: skill.name, description: current.description, body: current.body, sourcePath: skill.sourcePath, sourceSha256: skill.sourceSha256, modified: current.hash !== skill.hash }; }));
      return { ...result, skills: documents };
    },
    install(input, { approve, signal } = {}) {
      return serialize(async () => {
        if (!plain(input) || Object.keys(input).some(key => key !== 'planId') || typeof input.planId !== 'string') throw fail('플러그인 설치 요청을 확인해 주세요.');
        const plan = plans.get(input.planId); plans.delete(input.planId);
        if (!plan || plan.expiresAt < Date.now()) throw fail('플러그인 설치 계획이 만료되었습니다. 다시 확인해 주세요.');
        cancelled(signal);
        const previous = await load();
        if (previous.some(item => item.name === plan.name)) throw fail('이미 설치된 플러그인입니다. 기존 설치를 보존했습니다.');
        if (previous.length >= 64) throw fail('설치할 수 있는 플러그인 수를 초과했습니다.');
        const known = await skills.list();
        if (plan.skills.some(item => known.some(skill => skill.name === item.name))) throw fail('기존 스킬 이름과 충돌해 설치하지 않았습니다.');
        const proposal = structuredClone({ ...plan, warning: 'SiteCAD 전용 지침형 플러그인 설치입니다. 원문 지침을 검토하세요. MCP·코드·앱·훅을 설치하거나 새 권한을 부여하지 않습니다.' });
        if (Buffer.byteLength(JSON.stringify(proposal)) > 512 * 1024) throw fail('플러그인 설치 검토 내용을 한 번에 표시할 수 없습니다.');
        if (typeof approve !== 'function' || await approve(proposal) !== true) throw fail('플러그인 설치를 승인하지 않았습니다.');
        if (plan.expiresAt < Date.now()) throw fail('플러그인 설치 계획이 만료되었습니다. 다시 확인해 주세요.');
        const created = [];
        try {
          for (const source of plan.skills) {
            cancelled(signal);
            const saved = await skills.save({ name: source.name, description: source.description, body: source.body });
            created.push({ name: saved.name, hash: saved.hash, sourcePath: source.sourcePath, sourceSha256: source.sourceSha256 });
          }
          cancelled(signal);
          const item = { name: plan.name, version: plan.version, repository: plan.repository, sourceCommit: plan.sourceCommit, manifestPath: plan.manifestPath, manifestSha256: plan.manifestSha256, skills: created };
          await store([...previous, item]); return metadata(item, 'installed');
        } catch (error) {
          try { await rollback(created); } catch { throw fail('설치 중 변경된 스킬을 보존했습니다. 일부 지침이 남아 있을 수 있으니 설치 상태를 확인해 주세요.'); }
          throw error.sitecadSafe ? error : fail('플러그인 설치에 실패해 이번에 추가한 스킬을 되돌렸습니다. 기존 스킬은 보존했습니다.');
        }
      });
    },
    remove(name, { approve, signal } = {}) {
      return serialize(async () => {
        cancelled(signal);
        const previous = await load(), item = existing(previous, name);
        const documents = await Promise.all(item.skills.map(skill => skills.read(skill.name)));
        if (documents.some((skill, index) => skill.hash !== item.skills[index].hash)) throw fail('플러그인 스킬이 변경되어 삭제하지 않았습니다. 사용자 변경 내용을 먼저 확인해 주세요.');
        if (typeof approve !== 'function' || await approve(structuredClone({ name, repository: item.repository, sourceCommit: item.sourceCommit, skills: documents.map(({ path, ...skill }) => skill) })) !== true) throw fail('플러그인 삭제를 승인하지 않았습니다.');
        const removed = [];
        try {
          for (const skill of documents) { cancelled(signal); await skills.remove(skill.name, skill.hash); removed.push(skill); }
          cancelled(signal); await store(previous.filter(value => value.name !== name)); return { name, removed: true };
        } catch (error) {
          try { for (const skill of removed) await skills.save({ name: skill.name, description: skill.description, body: skill.body }); }
          catch { throw fail('삭제 중 변경된 스킬을 보존했습니다. 일부 지침을 복원하지 못했으니 설치 상태를 확인해 주세요.'); }
          throw error.sitecadSafe ? error : fail('플러그인 삭제에 실패해 기존 스킬을 복원했습니다. 설치 상태를 확인해 주세요.');
        }
      });
    },
  };
}
