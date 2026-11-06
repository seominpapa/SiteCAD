import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const context = { documentId: 1, revision: 0, units: 4, selection: [], entities: [] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-chat-files-http-')), turns = [];
  const controller = await createDesktopController({ dataDir, nodePath: process.execPath, codexPath: '/fixture/codex', secureStore: {},
    authFactory: async () => ({ status: async () => ({ loggedIn: true, sharing: true }), getAccessToken: async () => 'token', close: async () => {} }),
    runtimeFactory: async () => ({ start: async () => {}, stop: async () => {}, cancel: async () => {}, status: () => ({ connected: true }), chat: async (input, options) => { turns.push({ input, options }); return { reply: '첨부 확인 완료' }; } }) });
  let owned = true;
  const server = createApp({ desktop: controller, browserAccess: { protect: async () => true, assertOwner: () => { if (!owned) throw Object.assign(Error('다른 탭입니다.'), { status: 403 }); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; await controller.start({ baseUrl: base });
  t.after(async () => { await controller.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: base, ...init.headers } });
  return { base, request, controller, turns, setOwner: value => { owned = value; } };
}
function form(chatId, name = '화면.png', bytes = png) {
  const body = new FormData(); body.set('chatId', chatId); body.append('files', new Blob([bytes]), name); return body;
}
test('real multipart upload resolves native runtime input, persists metadata, retains followups, and deletes with chat', async t => {
  const s = await setup(t), chat = (await s.controller.chatCreate()).chat, other = (await s.controller.chatCreate()).chat;
  const uploaded = await s.request('/api/desktop/chat/attachments', { method: 'POST', body: form(chat.id) });
  assert.equal(uploaded.status, 200);
  const [attachment] = (await uploaded.json()).data.attachments;
  assert.equal(attachment.name, '화면.png'); assert.equal(attachment.mimeType, 'image/png');
  const submit = chatId => s.request('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '화면을 검토해줘', context, history: [], chatId, attachments: [attachment.id] }) });
  assert.equal((await submit(chat.id)).status, 200);
  assert.equal(s.turns[0].options.attachmentInputs[0].imageData, png.toString('base64'));
  assert.equal(JSON.stringify(s.turns[0].input).includes(png.toString('base64')), false);
  assert.deepEqual((await s.controller.chatRead(chat.id)).chat.messages[0].attachments, [attachment]);
  await s.controller.chat({ chatId: chat.id, message: '아까 화면 다시 확인해줘', context, history: [] });
  assert.equal(s.turns[1].options.attachmentInputs[0].previous, true);
  assert.equal((await submit(other.id)).status, 400); assert.equal(s.turns.length, 2);
  await s.controller.chatDelete({ id: chat.id });
  await assert.rejects(s.controller.chatAttachmentsUpload({ chatId: chat.id, files: [{ name: 'a.png', bytes: png }] }));
});
test('upload rejects foreign origins/owners, extra fields, bad names and unsupported binary formats', async t => {
  const s = await setup(t), chat = (await s.controller.chatCreate()).chat, path = '/api/desktop/chat/attachments';
  assert.equal((await s.request(path, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: form(chat.id) })).status, 403);
  s.setOwner(false); assert.equal((await s.request(path, { method: 'POST', body: form(chat.id) })).status, 403); s.setOwner(true);
  assert.equal((await s.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
  const extra = form(chat.id); extra.set('path', '/private/secret');
  assert.equal((await s.request(path, { method: 'POST', body: extra })).status, 400);
  const bad = await s.request(path, { method: 'POST', body: form(chat.id, 'program.exe', Buffer.from('MZ')) });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /PNG/);
  assert.equal((await s.request('/api/desktop/chat/attachments/00000000-0000-4000-8000-000000000001')).status, 403);
});
