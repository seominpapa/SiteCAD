import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_CHATS = 100, MAX_MESSAGES = 500, MAX_TEXT = 20000;
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT && !value.includes('\0');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validThread = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export async function createChatSessions({ dataDir }) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0')) throw Error('절대 경로의 채팅 기록 폴더가 필요합니다.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dataDir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('채팅 기록 폴더를 확인해 주세요.');
  const root = join(dataDir, 'chat-sessions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  async function checkRoot() {
    const parent = await lstat(dataDir);
    const info = await lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== join(await realpath(dataDir), 'chat-sessions')) throw Error('채팅 기록 폴더를 확인해 주세요.');
  }
  await checkRoot();
  await chmod(root, 0o700);
  let tail = Promise.resolve();
  const serial = operation => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  const pathFor = id => {
    if (typeof id !== 'string' || !ID.test(id)) throw Error('채팅 ID를 확인해 주세요.');
    return join(root, `${id}.json`);
  };
  function validate(chat, id) {
    if (!chat || chat.id !== id || typeof chat.title !== 'string' || !chat.title || chat.title.length > 100 || !validDate(chat.createdAt) || !validDate(chat.updatedAt) ||
      chat.nativeThreadId !== undefined && !validThread(chat.nativeThreadId) || !Array.isArray(chat.messages) || chat.messages.length > MAX_MESSAGES ||
      chat.messages.some(item => !item || !['user', 'assistant'].includes(item.role) || !validText(item.text) || !validDate(item.createdAt) || Object.keys(item).some(key => !['role', 'text', 'createdAt'].includes(key))) ||
      Object.keys(chat).some(key => !['id', 'title', 'createdAt', 'updatedAt', 'nativeThreadId', 'messages'].includes(key))) throw Error('채팅 기록 형식을 확인해 주세요.');
    return chat;
  }
  async function read(id) {
    const path = pathFor(id);
    await checkRoot();
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32 * 1024 * 1024 || (await lstat(path)).isSymbolicLink() || await realpath(path) !== join(await realpath(root), `${id}.json`)) throw Error();
      return validate(JSON.parse(await handle.readFile('utf8')), id);
    } catch { throw Error('채팅 기록을 읽지 못했습니다. 다른 채팅을 선택하거나 새 채팅을 만들어 주세요.'); }
    finally { await handle?.close(); }
  }
  async function write(chat) {
    await checkRoot();
    const path = pathFor(chat.id), temporary = join(root, `.${chat.id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(validate(chat, chat.id))}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return structuredClone(chat);
  }
  async function list() {
    await checkRoot();
    const ids = (await readdir(root)).filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5))).map(name => name.slice(0, -5));
    if (ids.length > MAX_CHATS) throw Error('채팅 기록이 너무 많습니다. 최대 100개의 채팅을 보관할 수 있습니다.');
    const summaries = [];
    for (const id of ids) {
      const { title, createdAt, updatedAt, messages } = await read(id);
      summaries.push({ id, title, createdAt, updatedAt, messageCount: messages.length });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  return {
    list, read,
    create: () => serial(async () => {
      if ((await list()).length >= MAX_CHATS) throw Error('채팅은 최대 100개까지 보관할 수 있습니다.');
      const now = new Date().toISOString();
      return write({ id: randomUUID(), title: '새 채팅', createdAt: now, updatedAt: now, messages: [] });
    }),
    recordTurn: (id, { message, reply } = {}) => serial(async () => {
      if (!validText(message) || !validText(reply)) throw Error('채팅 기록은 비어 있지 않은 20,000자 이하의 문장이어야 합니다.');
      const chat = await read(id);
      if (chat.messages.length + 2 > MAX_MESSAGES) throw Error('이 채팅의 기록 한도에 도달했습니다. 새 채팅을 만들어 주세요.');
      const now = new Date().toISOString();
      return write({ ...chat, title: chat.messages.length ? chat.title : message.trim().replace(/\s+/g, ' ').slice(0, 80), updatedAt: now,
        messages: [...chat.messages, { role: 'user', text: message, createdAt: now }, { role: 'assistant', text: reply, createdAt: now }] });
    }),
    setThread: (id, nativeThreadId) => serial(async () => {
      if (!validThread(nativeThreadId)) throw Error('채팅 실행 ID를 확인해 주세요.');
      return write({ ...await read(id), nativeThreadId });
    }),
  };
}
