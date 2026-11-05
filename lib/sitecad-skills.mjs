import { mkdir, lstat, open, writeFile, rename, link, unlink, readdir, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const bundled = fileURLToPath(new URL('../skills/', import.meta.url));
const builtinNames = Object.freeze({
  'quantity-review': '물량 산출·검증', 'design-review': '설계기준 검토', 'progress-markup': '기성도면 표시',
  'skill-creator': '스킬 만들기', 'skill-finder': '스킬 찾기', 'skill-installer': '스킬 설치',
});
const defaults = Object.keys(builtinNames);
const legacyHashes = Object.freeze({
  'quantity-review': 'af4640d479c9df4de560877712d77f6e45f5b9cd9faa6379cc1254ef88d56622',
  'skill-installer': '32a0362ea4879bfde7e0b405d928c47b51c5c1b02a9efb3eefcd6622459460b0',
  'skill-creator': '29da2a4b730980da73def686423c41a4d65e0238ad24737cada05eb0fcd0906c',
});
const MAX_BYTES = 64 * 1024;
const BACKGROUND_MARKER = '\n\n<!-- sitecad-background:v1\n';
const fail = () => Error('스킬 이름, 내용과 로컬 저장 경로를 확인해 주세요.');
const conflict = () => Error('스킬이 변경되었거나 이미 존재합니다. 현재 내용을 읽고 덮어쓰기 승인을 다시 받아 주세요.');
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const hash = value => createHash('sha256').update(value).digest('hex');

function checkedBackground(value) {
  const fields = ['situation', 'problem', 'changeReason', 'examplePrompt', 'expectedResult'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !validText(value[key], 4000)) || Object.keys(value).some(key => !fields.includes(key))) throw fail();
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

export function readSkillBackground(raw) {
  if (typeof raw !== 'string') throw fail();
  const offset = raw.lastIndexOf(BACKGROUND_MARKER);
  if (offset < 0) return undefined;
  const match = /^\n\n<!-- sitecad-background:v1\n([^\r\n]+)\n-->\n?$/.exec(raw.slice(offset));
  let value;
  try { value = JSON.parse(match?.[1]); } catch { throw fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['background', 'operation', 'previousHash', 'recordedAt'].includes(key)) || !['create', 'update'].includes(value.operation)) throw fail();
  if (value.operation === 'create' ? value.previousHash !== undefined : typeof value.previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousHash)) throw fail();
  if (value.recordedAt !== undefined && (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt)) throw fail();
  return { background: checkedBackground(value.background), operation: value.operation, ...(value.previousHash ? { previousHash: value.previousHash } : {}), ...(value.recordedAt ? { recordedAt: value.recordedAt } : {}) };
}

export function checkedSkillInputs({ skill, skills } = {}, codexHome) {
  if (!isAbsolute(codexHome ?? '') || skill !== undefined && skills !== undefined) throw fail();
  const items = skill === undefined ? skills ?? [] : [skill];
  if (!Array.isArray(items) || items.length > 6 || new Set(items.map(item => item?.name)).size !== items.length) throw fail();
  return items.map(item => {
    if (!item || !validName(item.name) || item.path !== join(codexHome, 'skills', item.name, 'SKILL.md')) throw fail();
    return { name: item.name, path: item.path };
  });
}

function naturalSkills(message) {
  const value = message.toLocaleLowerCase().replace(/\s+/g, '');
  const management = [
    ['skill-creator', /(?:스킬|skill)(?:로|을|를|하나|을하나|을새로|로새로|로정리해서)?(?:만들|생성|작성|저장|등록|create|save)|(?:스킬|skill)(?:을|를|의|에)?(?:내용|절차|규칙|지침)?(?:을|를|에)?(?:수정|변경|업데이트|개선|보완|반영|고쳐|update|modify|revise)/],
    ['skill-finder', /(?:스킬|skill)(?:을|를|좀|하나|을좀|를좀)?(?:찾|검색|추천|목록|리스트|find|search)|(?:맞는|적합한|관련된|적절한)(?:스킬|skill)/],
    ['skill-installer', /(?:스킬|skill)(?:을|를|좀|을좀|를좀)?(?:설치|install)|(?:설치|install).{0,12}(?:스킬|skill)/],
  ].filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  if (management.length) return management;
  const names = [];
  if (/(?:물량|수량|자재량|철근량|콘크리트량|토공량|중량|단중|총길이|quantity|take-?off)/.test(value) && /(?:산출|계산|검증|검토|검산|확인|맞는|맞나|맞아|차이|대조|비교|얼마|집계|합산|구해|뽑아|산정|calculate|verify|review|check)/.test(value) || /(?:철근|자재|콘크리트|토공|터파기|뒷채움|지수[제재]|강봉).{0,15}(?:얼마|몇개|몇본|몇톤|몇루베)/.test(value)) names.push('quantity-review');
  if (/(?:설계기준|시공기준|설계오류|도면오류|기준|규정|kds|kcs|피복|겹이음|철근규격|[뒷뒤]채움(?:재|경사))/.test(value) && /(?:검토|검증|위배|위반|적합|맞는|맞나|맞아|문제|오류|확인|충족|준수|review|check)/.test(value)) names.push('design-review');
  if (/(?:기성|청구)/.test(value) && /(?:표시|작성|그려|범위|영역|반영|포함|산출|계산|타설|완료|해줘|처리|청구)/.test(value) || /(?:기초|바닥판|저판)(?:콘크리트)?타설(?:완료|했|함|끝|$)/.test(value)) names.push('progress-markup');
  for (const name of defaults) {
    const label = builtinNames[name].replace(/[\s·]/g, '');
    if ((value.includes(name) || value.replaceAll('·', '').includes(label)) && /(?:사용|적용|실행|검토|해줘|처리|써줘|동작|use|run|review|apply)/.test(value)) names.push(name);
  }
  return defaults.filter(name => names.includes(name));
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
}

async function readDocument(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_BYTES) throw fail();
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > MAX_BYTES || raw.includes('\0')) throw fail();
    return raw;
  } finally { await handle.close(); }
}

function parse(raw, expectedName) {
  const match = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw fail();
  const scalar = value => value.startsWith('"') ? JSON.parse(value) : value;
  let name; let description;
  try { name = scalar(match[1]); description = scalar(match[2]); } catch { throw fail(); }
  const context = readSkillBackground(raw);
  const body = context ? match[3].slice(0, match[3].lastIndexOf(BACKGROUND_MARKER)) : match[3];
  if (name !== expectedName || !validName(name) || !validText(description, 1024) || /[\r\n]/.test(description) || !validText(body, MAX_BYTES)) throw fail();
  return { name, description, body, ...(context ? { background: context.background, backgroundChange: { operation: context.operation, ...(context.previousHash ? { previousHash: context.previousHash } : {}), ...(context.recordedAt ? { recordedAt: context.recordedAt } : {}) } } : {}) };
}

export async function createSitecadSkills({ codexHome, bundledDir = bundled }) {
  if (!isAbsolute(codexHome ?? '') || !isAbsolute(bundledDir ?? '')) throw fail();
  const root = join(codexHome, 'skills');
  let pending = Promise.resolve();
  const serialize = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const base = async () => { await directory(codexHome, true); await directory(root, true); };
  const read = async name => {
    if (!validName(name)) throw fail();
    await base();
    try {
      await directory(join(root, name));
      const path = join(root, name, 'SKILL.md');
      const raw = await readDocument(path);
      return { ...parse(raw, name), ...(defaults.includes(name) ? { displayName: builtinNames[name] } : {}), path, hash: hash(raw), builtin: defaults.includes(name) };
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('설치된 스킬을 찾지 못했습니다. 스킬 목록에서 명령 이름을 확인해 주세요.');
      throw fail();
    }
  };
  const metadata = ({ body, background, backgroundChange, ...item }) => item;
  const list = async () => {
    await base();
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 128) throw fail();
    const names = entries.filter(entry => !entry.name.startsWith('.')).map(entry => entry.name).sort();
    return Promise.all(names.map(async name => metadata(await read(name))));
  };
  const write = async (name, raw, replacing) => {
    await base();
    const dir = join(root, name);
    await directory(dir, true);
    const path = join(dir, 'SKILL.md');
    const temporary = join(dir, `.skill-${randomUUID()}.tmp`);
    await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
    try {
      // A new skill must never replace a file created concurrently by another process.
      if (replacing) await rename(temporary, path);
      else await link(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return metadata(await read(name));
  };
  return {
    seed() {
      return serialize(async () => {
        await base();
        await directory(bundledDir);
        for (const name of defaults) {
          const path = join(root, name, 'SKILL.md');
          let previous;
          try { await lstat(path); previous = await read(name); if (previous.hash !== legacyHashes[name]) continue; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await directory(join(bundledDir, name));
          const raw = await readDocument(join(bundledDir, name, 'SKILL.md'));
          parse(raw, name);
          if (previous && (previous.hash === hash(raw) || (await read(name)).hash !== previous.hash)) continue;
          await write(name, raw, Boolean(previous));
        }
        return list();
      });
    },
    async list() { await pending; return list(); },
    async read(name) { await pending; return read(name); },
    save(input) {
      return serialize(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'description', 'body', 'expectedHash', 'background'].includes(key))) throw fail();
        const { name, description, body, expectedHash } = input;
        if (!validName(name) || !validText(description, 1024) || /[\r\n]/.test(description) || !validText(body, MAX_BYTES) || body.includes(BACKGROUND_MARKER) || (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash))) throw fail();
        const suppliedBackground = input.background === undefined ? undefined : checkedBackground(input.background);
        if (defaults.includes(name)) throw Error('기본 스킬은 덮어쓸 수 없습니다. 다른 이름으로 만들어 주세요.');
        await base();
        let previous;
        try { await lstat(join(root, name)); previous = await read(name); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if ((previous && previous.hash !== expectedHash) || (!previous && expectedHash !== undefined)) throw conflict();
        if (!previous && (await list()).length >= 128) throw fail();
        const background = suppliedBackground ?? previous?.background;
        const context = background ? { background, operation: previous ? 'update' : 'create', ...(previous ? { previousHash: previous.hash } : {}), recordedAt: new Date().toISOString() } : undefined;
        const suffix = context ? `${BACKGROUND_MARKER}${JSON.stringify(context).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n-->\n` : '';
        const raw = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}${suffix}`;
        if (Buffer.byteLength(raw) > MAX_BYTES) throw fail();
        return write(name, raw, Boolean(previous));
      });
    },
    remove(name, expectedHash) {
      return serialize(async () => {
        if (!validName(name) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw fail();
        if (defaults.includes(name)) throw Error('기본 스킬은 삭제할 수 없습니다.');
        const current = await read(name);
        if (current.hash !== expectedHash) throw conflict();
        const dir = join(root, name), path = join(dir, 'SKILL.md');
        if ((await readdir(dir)).some(entry => entry !== 'SKILL.md')) throw Error('스킬에 다른 파일이 있어 삭제하지 않았습니다. 변경 내용을 확인해 주세요.');
        const raw = await readDocument(path);
        if (hash(raw) !== expectedHash) throw conflict();
        await unlink(path);
        try { await rmdir(dir); }
        catch (error) { await writeFile(path, raw, { mode: 0o600, flag: 'wx' }); throw error; }
        return { name, removed: true };
      });
    },
    async find(query) {
      if (typeof query !== 'string' || query.length > 512 || query.includes('\0')) throw fail();
      await pending;
      const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      return (await list()).filter(item => terms.every(term => `${item.name} ${item.description}`.toLocaleLowerCase().includes(term)));
    },
    async resolve(message) {
      if (typeof message !== 'string' || message.length > MAX_BYTES || message.includes('\0')) throw fail();
      const value = message.trim();
      if (!value.startsWith('/')) {
        await pending;
        const names = naturalSkills(value);
        if (!names.length) return null;
        const skills = await Promise.all(names.map(async name => {
          const item = await read(name);
          return { name: item.name, path: item.path };
        }));
        return { skills };
      }
      const match = /^\/([a-z][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/.exec(value);
      if (!match) throw fail();
      await pending;
      const item = await read(match[1]);
      const args = match[2] ?? '';
      return { name: item.name, args, message: args || `/${item.name}`, skill: { name: item.name, path: item.path } };
    },
  };
}
