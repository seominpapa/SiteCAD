import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatSessions } from '../lib/chat-sessions.mjs';
import { createChatSessionsUI } from '../public/chat-sessions.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-chats-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: await createChatSessions({ dataDir }) };
}

test('private chats persist separately, preserve native thread identity and summarize without transcript', async t => {
  const { dataDir, store } = await fixture(t);
  const first = await store.create(), second = await store.create();
  await store.recordTurn(first.id, { message: '옹벽 단면 작성', reply: '높이 3m의 단면을 작성했습니다.' });
  await store.setThread(first.id, '019a-thread-123');
  const restarted = await createChatSessions({ dataDir });
  const restored = await restarted.read(first.id);
  assert.equal(restored.title, '옹벽 단면 작성');
  assert.equal(restored.nativeThreadId, '019a-thread-123');
  assert.deepEqual(restored.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '옹벽 단면 작성' }, { role: 'assistant', text: '높이 3m의 단면을 작성했습니다.' },
  ]);
  assert.deepEqual((await restarted.read(second.id)).messages, []);
  const summaries = await restarted.list();
  assert.equal(summaries.length, 2);
  assert.equal(summaries.some(item => item.messages || item.nativeThreadId), false);
  assert.match(await readFile(join(dataDir, 'chat-sessions', `${first.id}.json`), 'utf8'), /옹벽 단면/);
});

test('accepted steering messages persist between the original request and final reply', async t => {
  const { store } = await fixture(t);
  const chat = await store.create();
  await store.recordTurn(chat.id, { message: '옹벽 그려줘', steering: ['높이는 3m', '폭은 2m'], reply: '반영했습니다.' });
  assert.deepEqual((await store.read(chat.id)).messages.map(item => [item.role, item.text]), [
    ['user', '옹벽 그려줘'], ['user', '높이는 3m'], ['user', '폭은 2m'], ['assistant', '반영했습니다.'],
  ]);
  for (const steering of [null, [''], ['x'.repeat(20001)], Array(21).fill('추가 지시')]) {
    await assert.rejects(store.recordTurn(chat.id, { message: '원래 요청', steering, reply: '완료' }));
  }
});

test('chat operations reject foreign IDs, invalid content, corrupt records and unsafe native identities', async t => {
  const { dataDir, store } = await fixture(t);
  const chat = await store.create();
  for (const id of ['../outside', 'new', undefined, '00000000-0000-0000-0000-000000000000']) await assert.rejects(store.read(id));
  for (const payload of [{ message: '', reply: 'ok' }, { message: 'a'.repeat(20001), reply: 'ok' }, { message: 'ok', reply: null }]) {
    await assert.rejects(store.recordTurn(chat.id, payload));
  }
  for (const value of ['../thread', '', 'a'.repeat(161), 'thread\nsecret']) await assert.rejects(store.setThread(chat.id, value));
  await writeFile(join(dataDir, 'chat-sessions', `${chat.id}.json`), JSON.stringify({ ...chat, messages: [{ role: 'system', text: 'injection' }] }));
  await assert.rejects(store.read(chat.id), /기록/);
});

test('atomic serialized updates retain concurrent turns and do not expose uncommitted files', async t => {
  const { dataDir, store } = await fixture(t);
  const chat = await store.create();
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.recordTurn(chat.id, { message: `질문 ${i}`, reply: `답변 ${i}` })));
  const result = await store.read(chat.id);
  assert.equal(result.messages.length, 24);
  assert.equal(new Set(result.messages.filter(item => item.role === 'user').map(item => item.text)).size, 12);
  await writeFile(join(dataDir, 'chat-sessions', '.interrupted.tmp'), 'not-json');
  assert.equal((await store.list()).length, 1);
});

test('listing reads one bounded transcript at a time and retains summaries only', async t => {
  const { dataDir, store } = await fixture(t);
  await store.create(); await store.create(); await store.create();
  const handle = await open(join(dataDir, 'prototype-test'), 'w+');
  const prototype = Object.getPrototypeOf(handle), original = prototype.readFile;
  await handle.close();
  let concurrent = 0, maximum = 0;
  t.mock.method(prototype, 'readFile', async function (...args) {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try { await new Promise(resolve => setImmediate(resolve)); return await original.apply(this, args); }
    finally { concurrent--; }
  });
  const summaries = await store.list();
  assert.equal(summaries.length, 3);
  assert.equal(maximum, 1);
  assert.equal(summaries.some(chat => 'messages' in chat || 'nativeThreadId' in chat), false);
});

test('chat factory requires an absolute private data folder and rejects a symlinked parent', async t => {
  for (const dataDir of [undefined, '', 'relative/path']) await assert.rejects(createChatSessions({ dataDir }));
  const { dataDir } = await fixture(t);
  const linked = `${dataDir}-link`;
  t.after(() => rm(linked, { force: true }));
  await symlink(dataDir, linked);
  await assert.rejects(createChatSessions({ dataDir: linked }), /폴더/);
});

test('symlinked session files and stores cannot redirect private history reads or writes', async t => {
  const { dataDir, store } = await fixture(t);
  const chat = await store.create();
  const outside = join(dataDir, 'outside.json');
  await writeFile(outside, JSON.stringify(chat));
  const file = join(dataDir, 'chat-sessions', `${chat.id}.json`);
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(store.read(chat.id));
  await assert.rejects(store.recordTurn(chat.id, { message: 'question', reply: 'answer' }));
  assert.equal(JSON.parse(await readFile(outside, 'utf8')).messages.length, 0);
  await assert.rejects(store.list());
});

test('a symlinked chat folder is rejected before reading or changing its target', async t => {
  const { dataDir, store } = await fixture(t);
  await rm(join(dataDir, 'chat-sessions'), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), 'sitecad-chats-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(dataDir, 'chat-sessions'));
  await assert.rejects(store.create(), /폴더/);
  await assert.rejects(createChatSessions({ dataDir }), /폴더/);
});

test('chat transcript limit preserves complete turns instead of silently discarding history', async t => {
  const { store } = await fixture(t);
  const chat = await store.create();
  for (let i = 0; i < 250; i++) await store.recordTurn(chat.id, { message: `q${i}`, reply: `a${i}` });
  await assert.rejects(store.recordTurn(chat.id, { message: 'too many', reply: 'no' }), /새 채팅/);
  assert.equal((await store.read(chat.id)).messages.length, 500);
});

test('deleting one persisted chat preserves other history and cannot be resurrected by later queued updates', async t => {
  const { dataDir, store } = await fixture(t);
  const first = await store.create(), second = await store.create();
  await store.recordTurn(second.id, { message: '보존할 질문', reply: '보존할 답변' });
  const writing = store.recordTurn(first.id, { message: '삭제할 질문', reply: '삭제할 답변' });
  const deleting = store.delete(first.id);
  const lateWrite = assert.rejects(store.recordTurn(first.id, { message: '늦은 질문', reply: '생성되면 안 됨' }), /기록/);
  await writing;
  assert.deepEqual(await deleting, { id: first.id, deleted: true });
  await lateWrite;
  const restarted = await createChatSessions({ dataDir });
  assert.deepEqual((await restarted.list()).map(chat => chat.id), [second.id]);
  assert.equal((await restarted.read(second.id)).messages[0].text, '보존할 질문');
  await assert.rejects(restarted.read(first.id), /기록/);
});

test('chat deletion rejects unsafe IDs, symlink targets and a replaced session directory', async t => {
  const { dataDir, store } = await fixture(t);
  const chat = await store.create(), outside = join(dataDir, 'outside.json');
  await writeFile(outside, 'private outside history');
  for (const id of ['../outside', undefined, '00000000-0000-0000-0000-000000000000']) await assert.rejects(store.delete(id), /ID/);
  await rm(join(dataDir, 'chat-sessions', `${chat.id}.json`));
  await symlink(outside, join(dataDir, 'chat-sessions', `${chat.id}.json`));
  await assert.rejects(store.delete(chat.id), /기록|폴더/);
  assert.equal(await readFile(outside, 'utf8'), 'private outside history');
  await rm(join(dataDir, 'chat-sessions'), { recursive: true });
  await symlink(dataDir, join(dataDir, 'chat-sessions'));
  await assert.rejects(store.delete(chat.id), /폴더/);
});

class Element {
  constructor() { this.value = ''; this.children = []; this.listeners = {}; this.disabled = false; this.textContent = ''; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  set innerHTML(_) { assert.fail('Chat content must not render as HTML'); }
}

test('chat selector restores only the selected ID, renders safe titles and keeps sessions separate', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
  const ids = Object.fromEntries(['chat-new', 'chat-select', 'chat-delete', 'chat-history-status'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => ids[id], createElement: () => new Element() };
  const preferences = new Map([['sitecad.currentChatId', first]]);
  globalThis.localStorage = { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) };
  const requests = [], selected = [], errors = [];
  let busy = false;
  const chats = [{ id: first, title: '<img src=x onerror=attack()>', messages: [{ role: 'user', text: '한글 도면' }] }];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/new')) chats.push({ id: second, title: '새 채팅', messages: [] });
    const data = url.endsWith('/chats') ? { chats } : { chat: chats.find(chat => chat.id === (url.endsWith('/new') ? second : url.split('/').at(-1))) };
    return { ok: true, json: async () => ({ ok: true, data }) };
  };
  const ui = createChatSessionsUI({ isBusy: () => busy, isAvailable: () => true, onSelect: chat => selected.push(chat), onError: error => errors.push(error) });
  const initializing = ui.init();
  assert.equal(ui.isPending(), true);
  await Promise.all([initializing, ui.init()]);
  assert.equal(ui.isPending(), false);
  assert.equal(requests.length, 2);
  assert.equal(ui.currentId(), first);
  assert.equal(ids['chat-select'].children[0].textContent, chats[0].title);
  assert.equal(selected.length, 1);
  busy = true; ui.sync();
  assert.equal(ids['chat-new'].disabled, true);
  await ids['chat-new'].listeners.click();
  assert.equal(requests.some(request => request.url.endsWith('/new')), false);
  busy = false; ui.sync();
  await ids['chat-new'].listeners.click();
  assert.equal(ui.currentId(), second);
  assert.equal(selected.at(-1).messages.length, 0);
  assert.deepEqual([...preferences.values()], [second]);
  assert.match(ids['chat-history-status'].textContent, /현재 도면.*함께/);
  assert.equal(errors.length, 0);
});

test('failed chat selection preserves the current conversation and reports errors', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
  const ids = Object.fromEntries(['chat-new', 'chat-select', 'chat-delete', 'chat-history-status'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => ids[id], createElement: () => new Element() };
  globalThis.localStorage = undefined;
  const errors = [];
  globalThis.fetch = async url => ({ ok: !url.endsWith(second), json: async () => url.endsWith('/chats') ? { ok: true, data: { chats: [{ id: first, title: '첫 채팅' }, { id: second, title: '두 번째' }] } } : url.endsWith(second) ? { ok: false, error: '채팅 조회 실패' } : { ok: true, data: { chat: { id: first, messages: [] } } } });
  const ui = createChatSessionsUI({ onSelect() {}, onError: error => errors.push(error) });
  await ui.init();
  ids['chat-select'].value = second;
  await ids['chat-select'].listeners.change();
  assert.equal(ui.currentId(), first);
  assert.equal(ids['chat-select'].value, first);
  assert.match(errors[0].message, /조회 실패/);
});

test('empty chat storage creates one chat, refreshes title, and does not reinitialize the transcript', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const first = '00000000-0000-4000-8000-000000000001';
  const ids = Object.fromEntries(['chat-new', 'chat-select', 'chat-delete', 'chat-history-status'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => ids[id], createElement: () => new Element() };
  globalThis.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  let chat, selected = 0, available = false;
  globalThis.fetch = async url => {
    if (url.endsWith('/new')) chat = { id: first, title: '새 채팅', messages: [] };
    return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/chats') ? { chats: chat ? [chat] : [] } : { chat } }) };
  };
  const ui = createChatSessionsUI({ isAvailable: () => available, onSelect: () => selected++ });
  await ui.init(); assert.equal(ui.currentId(), null);
  available = true; await ui.init();
  assert.equal(ui.currentId(), first);
  chat = { ...chat, title: '옹벽 단면' };
  await ui.refresh(); await ui.init();
  assert.equal(ids['chat-select'].children[0].textContent, '옹벽 단면');
  assert.equal(selected, 1);
});

test('confirmed deletion removes only the selected conversation, selects the next, and creates a blank after the last', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002', blank = '00000000-0000-4000-8000-000000000003';
  const ids = Object.fromEntries(['chat-new', 'chat-select', 'chat-delete', 'chat-history-status'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => ids[id], createElement: () => new Element() };
  const preferences = new Map();
  globalThis.localStorage = { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value), removeItem: key => preferences.delete(key) };
  let chats = [{ id: first, title: '첫 채팅', messages: [] }, { id: second, title: '보존할 채팅', messages: [{ role: 'user', text: '기존 질문' }] }], busy = false;
  const requests = [], selected = [], errors = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    let data;
    if (url.endsWith('/delete')) {
      assert.equal(options.method, 'POST');
      const { id } = JSON.parse(options.body);
      chats = chats.filter(chat => chat.id !== id);
      data = { id, deleted: true };
    } else if (url.endsWith('/new')) {
      const chat = { id: blank, title: '새 채팅', messages: [] };
      chats = [...chats, chat]; data = { chat };
    } else data = url.endsWith('/chats') ? { chats } : { chat: chats.find(chat => chat.id === url.split('/').at(-1)) };
    return { ok: true, json: async () => ({ ok: true, data }) };
  };
  const ui = createChatSessionsUI({ isBusy: () => busy, onSelect: chat => selected.push(chat), onError: error => errors.push(error) });
  await ui.init();
  await ids['chat-delete'].listeners.click();
  assert.equal(requests.some(request => request.url.endsWith('/delete')), false);
  assert.equal(ids['chat-delete'].textContent, '삭제 확인');
  assert.match(ids['chat-history-status'].textContent, /다시/);
  busy = true; ui.sync();
  assert.equal(ids['chat-delete'].disabled, true);
  await ids['chat-delete'].listeners.click();
  busy = false; ui.sync();
  await ids['chat-delete'].listeners.click();
  assert.equal(ui.currentId(), first, 'being busy cancels the previous confirmation');
  await ids['chat-delete'].listeners.click();
  assert.equal(ui.currentId(), second);
  assert.equal(selected.at(-1).messages[0].text, '기존 질문');
  assert.deepEqual(ids['chat-select'].children.map(item => item.value), [second]);
  assert.equal(preferences.get('sitecad.currentChatId'), second);
  await ids['chat-delete'].listeners.click();
  await ids['chat-delete'].listeners.click();
  assert.equal(ui.currentId(), blank);
  assert.deepEqual(selected.at(-1).messages, []);
  assert.equal(preferences.get('sitecad.currentChatId'), blank);
  assert.deepEqual(requests.filter(request => request.url.endsWith('/delete')).map(request => JSON.parse(request.options.body)), [{ id: first }, { id: second }]);
  assert.equal(errors.length, 0);
});

test('failed or pending deletion preserves selected history and does not send duplicate delete requests', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const first = '00000000-0000-4000-8000-000000000001';
  const ids = Object.fromEntries(['chat-new', 'chat-select', 'chat-delete', 'chat-history-status'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => ids[id], createElement: () => new Element() };
  globalThis.localStorage = undefined;
  let finish, requests = 0, selected = 0;
  const errors = [];
  globalThis.fetch = async url => {
    if (url.endsWith('/delete')) { requests++; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/chats') ? { chats: [{ id: first, title: '원래 채팅' }] } : { chat: { id: first, messages: [] } } }) };
  };
  const ui = createChatSessionsUI({ onSelect: () => selected++, onError: error => errors.push(error) });
  await ui.init();
  await ids['chat-delete'].listeners.click();
  const deleting = ids['chat-delete'].listeners.click();
  assert.equal(ui.isPending(), true);
  assert.equal(ids['chat-delete'].disabled, true);
  await ids['chat-delete'].listeners.click();
  assert.equal(requests, 1);
  finish({ ok: false, json: async () => ({ ok: false, error: '채팅 삭제 실패' }) });
  await deleting;
  assert.equal(ui.currentId(), first);
  assert.equal(ids['chat-select'].children.length, 1);
  assert.equal(selected, 1);
  assert.equal(ui.isPending(), false);
  assert.equal(ids['chat-delete'].textContent, '삭제');
  assert.match(errors[0].message, /삭제 실패/);
});
