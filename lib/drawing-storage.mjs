import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const fail = () => Error('저장 폴더 설정을 확인해 주세요. 존재하는 폴더의 전체 경로와 쓰기 권한이 필요합니다.');
function checkedPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value && !isAbsolute(value)) throw fail();
  return value ? resolve(value) : '';
}

export async function createDrawingStorage({ dataDir, defaultPath }) {
  if (!checkedPath(dataDir) || !checkedPath(defaultPath)) throw fail();
  defaultPath = resolve(defaultPath);
  const file = join(dataDir, 'drawing-storage.json');
  async function read() {
    let handle;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw fail();
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!value || Array.isArray(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'path')) throw fail();
      return checkedPath(value.path);
    } catch (error) { if (error.code === 'ENOENT') return ''; throw fail(); }
    finally { await handle?.close(); }
  }
  let selected = await read(), queue = Promise.resolve();
  const status = () => ({ path: selected || defaultPath, defaultPath, isDefault: !selected || selected === defaultPath });
  async function directory(path = status().path) {
    try {
      if (path === defaultPath) await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
      return path;
    } catch { throw fail(); }
  }
  async function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'path')) throw fail();
    const next = checkedPath(input.path), path = await directory(next || defaultPath);
    const probe = join(path, `.sitecad-write-${randomUUID()}.tmp`), temporary = join(dataDir, `.drawing-storage-${randomUUID()}.tmp`);
    try {
      await read();
      // Probe write access without changing permissions on the user's folder.
      await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      await rm(probe);
      await writeFile(temporary, JSON.stringify({ version: 1, path: next }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      selected = next;
      return status();
    } catch { throw fail(); }
    // Cleanup must not turn a committed preference into a reported failure.
    finally { await Promise.allSettled([rm(probe, { force: true }), rm(temporary, { force: true })]); }
  }
  return { status, directory, save(input) {
    const next = queue.then(() => save(input)); queue = next.catch(() => {}); return next;
  } };
}
