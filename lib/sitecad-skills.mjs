import { mkdir, lstat, open, writeFile, rename, link, unlink, readdir, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const bundled = fileURLToPath(new URL('../skills/', import.meta.url));
const defaults = ['skill-creator', 'skill-finder', 'skill-installer'];
const MAX_BYTES = 64 * 1024;
const fail = () => Error('스킬 이름, 내용과 로컬 저장 경로를 확인해 주세요.');
const conflict = () => Error('스킬이 변경되었거나 이미 존재합니다. 현재 내용을 읽고 덮어쓰기 승인을 다시 받아 주세요.');
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const hash = value => createHash('sha256').update(value).digest('hex');

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
  if (name !== expectedName || !validName(name) || !validText(description, 1024) || /[\r\n]/.test(description) || !validText(match[3], MAX_BYTES)) throw fail();
  return { name, description, body: match[3] };
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
      return { ...parse(raw, name), path, hash: hash(raw), builtin: defaults.includes(name) };
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('설치된 스킬을 찾지 못했습니다. 스킬 목록에서 명령 이름을 확인해 주세요.');
      throw fail();
    }
  };
  const metadata = ({ body, ...item }) => item;
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
          try { await lstat(path); await read(name); continue; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await directory(join(bundledDir, name));
          const raw = await readDocument(join(bundledDir, name, 'SKILL.md'));
          parse(raw, name);
          await write(name, raw, false);
        }
        return list();
      });
    },
    async list() { await pending; return list(); },
    async read(name) { await pending; return read(name); },
    save(input) {
      return serialize(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'description', 'body', 'expectedHash'].includes(key))) throw fail();
        const { name, description, body, expectedHash } = input;
        if (!validName(name) || !validText(description, 1024) || /[\r\n]/.test(description) || !validText(body, MAX_BYTES) || (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash))) throw fail();
        if (defaults.includes(name)) throw Error('기본 스킬은 덮어쓸 수 없습니다. 다른 이름으로 만들어 주세요.');
        const raw = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
        if (Buffer.byteLength(raw) > MAX_BYTES) throw fail();
        await base();
        let previous;
        try { await lstat(join(root, name)); previous = await read(name); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if ((previous && previous.hash !== expectedHash) || (!previous && expectedHash !== undefined)) throw conflict();
        if (!previous && (await list()).length >= 128) throw fail();
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
      if (!value.startsWith('/')) return null;
      const match = /^\/([a-z][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/.exec(value);
      if (!match) throw fail();
      await pending;
      const item = await read(match[1]);
      const args = match[2] ?? '';
      return { name: item.name, args, message: args || `/${item.name}`, skill: { name: item.name, path: item.path } };
    },
  };
}
