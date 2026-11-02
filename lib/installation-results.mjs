import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const messages = {
  connected: 'MCP 설치와 실제 도구 연결을 확인했습니다.',
  installed: '플러그인 설치를 완료했습니다.',
  key_required: 'MCP를 등록했습니다. 설정 → API에서 필요한 인증정보를 입력해 주세요.',
  failed: '설치 또는 연결 확인을 완료하지 못했습니다. 현재 연결 목록과 채팅 안내를 확인해 주세요.',
};
const statuses = { mcp: ['connected', 'key_required', 'failed'], plugin: ['installed', 'failed'] };
const validKind = kind => Object.hasOwn(statuses, kind);
const validOutcome = item => item && typeof item === 'object' && !Array.isArray(item) && validKind(item.kind) && statuses[item.kind].includes(item.status) && typeof item.name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item.name);
const fail = () => Error('설치 기록을 읽거나 저장하지 못했습니다. 현재 연결 상태를 확인해 주세요.');

export function createInstallationResults({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0')) throw fail();
  const file = join(dataDir, 'installation-results.json');
  let queue = Promise.resolve();
  const serialized = callback => { const next = queue.then(callback); queue = next.catch(() => {}); return next; };
  async function checkRoot() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const info = await lstat(dataDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  async function read() {
    await checkRoot();
    let handle;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw fail();
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'results'].includes(key)) || !Array.isArray(value.results) || value.results.length > 30) throw fail();
      const ids = new Set();
      for (const item of value.results) {
        if (!validOutcome(item) || Object.keys(item).length !== 6 || Object.keys(item).some(key => !['id', 'kind', 'name', 'status', 'message', 'createdAt'].includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.id ?? '') || ids.has(item.id) || item.message !== messages[item.status] || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw fail();
        ids.add(item.id);
      }
      return value.results;
    } catch (error) { if (error.code === 'ENOENT') return []; throw fail(); }
    finally { await handle?.close(); }
  }
  return {
    list: kind => serialized(async () => {
      if (!validKind(kind)) throw fail();
      return (await read()).filter(item => item.kind === kind);
    }),
    record: value => serialized(async () => {
      if (!validOutcome(value) || Object.keys(value).some(key => !['kind', 'name', 'status', 'message'].includes(key))) throw fail();
      const prior = await read();
      // Caller error text, arguments and credentials must never become history metadata.
      const item = { id: randomUUID(), kind: value.kind, name: value.name, status: value.status, message: messages[value.status], createdAt: new Date().toISOString() };
      const temporary = join(dataDir, `.installation-results-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, results: [item, ...prior].slice(0, 30) }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch { throw fail(); }
      finally { await rm(temporary, { force: true }); }
      return item;
    }),
  };
}
