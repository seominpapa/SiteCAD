import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentContext, createChatAttachments } from '../lib/chat-attachments.mjs';
import { validateChat } from '../lib/plan.mjs';
import { createChatSessions } from '../lib/chat-sessions.mjs';

const chatId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-chat-files-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: await createChatAttachments({ dataDir }) };
}

test('private chat attachments survive restart, stay scoped, and retain real image/text inputs', async t => {
  const { dataDir, store } = await fixture(t);
  const uploaded = await store.save(chatId, [{ name: '화면.png', bytes: png }, { name: '검토.csv', bytes: Buffer.from('항목,수량\n콘크리트,12') }]);
  assert.equal(uploaded.length, 2); assert.equal(uploaded[0].kind, 'image');
  assert.equal(JSON.stringify(uploaded).includes(dataDir), false);
  const restarted = await createChatAttachments({ dataDir });
  const turn = await restarted.forTurn(chatId, uploaded.map(item => item.id), []);
  assert.equal(turn.attachments.length, 2);
  assert.equal(turn.inputs[0].imageData, png.toString('base64'));
  assert.deepEqual(await readFile(turn.inputs[0].imagePath), png);
  assert.match(turn.inputs[1].text, /콘크리트,12/);
  if (process.platform !== 'win32') assert.equal((await stat(turn.inputs[0].imagePath)).mode & 0o777, 0o600);
  await assert.rejects(restarted.forTurn(otherId, [uploaded[0].id], []), /첨부/);
  const following = await restarted.forTurn(chatId, [], [{ role: 'user', attachments: uploaded }]);
  assert.equal(following.inputs.length, 2); assert.equal(following.inputs[0].previous, true);
  await restarted.deleteChat(chatId);
  await assert.rejects(restarted.forTurn(chatId, [uploaded[0].id], []), /첨부/);
});

test('uploads reject traversal, unsupported binaries, forged image types and limits before saving', async t => {
  const { store } = await fixture(t);
  for (const files of [[], [{ name: '../secret.txt', bytes: Buffer.from('a') }], [{ name: 'a.exe', bytes: Buffer.from('MZ') }], [{ name: 'a.png', bytes: Buffer.from('not image') }], [{ name: 'a.txt', bytes: Buffer.from([0xff]) }], [{ name: 'a.txt', bytes: Buffer.from('a\0b') }], Array.from({ length: 5 }, () => ({ name: 'a.txt', bytes: Buffer.from('a') })), [{ name: 'a.txt', bytes: Buffer.alloc(1024 * 1024 + 1, 65) }], [{ name: 'a.png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }]]) await assert.rejects(store.save(chatId, files), /파일|첨부|형식|MiB/);
  await assert.rejects(store.save('../outside', [{ name: 'a.txt', bytes: Buffer.from('a') }]), /채팅/);
  await assert.rejects(store.forTurn(chatId, ['../secret'], []), /첨부/);
});

test('PDF extraction uses isolated existing reader and reports partial text/first-page visual coverage', async t => {
  const { dataDir } = await fixture(t);
  const store = await createChatAttachments({ dataDir, pdfReader: async (_bytes, signal, page) => {
    assert.equal(page, 1); assert.equal(signal.aborted, false);
    return { content: '철근 D19', pages: 40, pagesRead: 30, truncated: true, images: [{ mimeType: 'image/jpeg', data: Buffer.from('preview').toString('base64') }] };
  } });
  const [metadata] = await store.save(chatId, [{ name: '구조도.pdf', bytes: Buffer.from('%PDF-1.7 fixture') }]);
  assert.match(metadata.warning, /1쪽/); assert.match(metadata.warning, /30/);
  const { inputs } = await store.forTurn(chatId, [metadata.id], []);
  assert.equal(inputs[0].text, '철근 D19'); assert.equal(inputs[0].imageMimeType, 'image/jpeg');
  assert.equal(await readFile(inputs[0].imagePath, 'utf8'), 'preview');
});

test('recent attachment context is bounded and no symlink can redirect private storage', async t => {
  const { dataDir, store } = await fixture(t);
  const older = await store.save(chatId, Array.from({ length: 4 }, (_, index) => ({ name: `${index}.txt`, bytes: Buffer.from('old') })));
  const latest = await store.save(chatId, [{ name: 'new.txt', bytes: Buffer.from('new') }]);
  const turn = await store.forTurn(chatId, latest.map(item => item.id), [{ role: 'user', attachments: older }]);
  assert.equal(turn.inputs.length, 4); assert.equal(turn.inputs[0].name, 'new.txt'); assert.match(turn.warning, /최근/);
  const foreign = await mkdtemp(join(tmpdir(), 'sitecad-chat-files-outside-'));
  t.after(() => rm(foreign, { recursive: true, force: true }));
  await rm(join(dataDir, 'chat-attachments'), { recursive: true });
  await symlink(foreign, join(dataDir, 'chat-attachments'));
  await assert.rejects(store.save(chatId, [{ name: 'safe.txt', bytes: Buffer.from('safe') }]), /폴더/);
});

test('chat validation accepts only bounded opaque attachment IDs and history persists safe metadata', async t => {
  const request = { message: '검토해줘', context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [], attachments: [chatId] };
  assert.equal(validateChat(request), request);
  for (const attachments of [[{ path: '/private/file' }], ['../secret'], Array(5).fill(chatId), [chatId, chatId]]) assert.throws(() => validateChat({ ...request, attachments }));
  const { dataDir, store } = await fixture(t), sessions = await createChatSessions({ dataDir }), chat = await sessions.create();
  const attachments = await store.save(chat.id, [{ name: '현장.png', bytes: png }]);
  await sessions.recordTurn(chat.id, { message: '검토해줘', reply: '확인했습니다.', attachments });
  assert.deepEqual((await sessions.read(chat.id)).messages[0].attachments, attachments);
  await assert.rejects(sessions.recordTurn(chat.id, { message: 'bad', reply: 'bad', attachments: [{ ...attachments[0], path: '/private/file' }] }));
});

test('stale draft uploads are reclaimed on the next upload while saved chat attachments remain', async t => {
  const { dataDir, store } = await fixture(t);
  const saved = await store.save(chatId, [{ name: '보존.txt', bytes: Buffer.from('saved') }]);
  const draft = await store.save(chatId, [{ name: '취소한 첨부.txt', bytes: Buffer.from('draft') }]);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const item of [...saved, ...draft]) await utimes(join(dataDir, 'chat-attachments', chatId, item.id, 'metadata.json'), old, old);
  await store.save(chatId, [{ name: '새 첨부.txt', bytes: Buffer.from('new') }], { referencedIds: saved.map(item => item.id) });
  assert.equal((await store.forTurn(chatId, [saved[0].id], [])).inputs[0].text, 'saved');
  await assert.rejects(store.forTurn(chatId, [draft[0].id], []), /첨부/);
});

test('a real PDF is parsed in the existing bounded worker and delivered with a real JPEG preview', async t => {
  const { store } = await fixture(t), stream = 'BT /F1 12 Tf 20 100 Td (Rebar D19 quantity 12) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let source = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const [file] = await store.save(chatId, [{ name: '표.pdf', bytes: Buffer.from(source) }]);
  const { inputs } = await store.forTurn(chatId, [file.id], []);
  assert.match(inputs[0].text, /Rebar D19 quantity 12/);
  assert.deepEqual((await readFile(inputs[0].imagePath)).subarray(0, 3), Buffer.from([255, 216, 255]));
  assert.match(file.warning, /1쪽/);
});

test('failed PDF batches roll back and symlinked source files never expose their destination', async t => {
  const { dataDir, store } = await fixture(t);
  await assert.rejects(store.save(chatId, [{ name: '정상.txt', bytes: Buffer.from('good') }, { name: '손상.pdf', bytes: Buffer.from('%PDF-broken') }]), /PDF/);
  assert.deepEqual(await readdir(join(dataDir, 'chat-attachments', chatId)), []);
  const [metadata] = await store.save(chatId, [{ name: '화면.png', bytes: png }]);
  const imagePath = (await store.forTurn(chatId, [metadata.id], [])).inputs[0].imagePath;
  const outside = join(dataDir, 'private-other-file'); await writeFile(outside, 'private destination');
  await rm(imagePath); await symlink(outside, imagePath);
  await assert.rejects(store.forTurn(chatId, [metadata.id], []), error => /첨부/.test(error.message) && !error.message.includes(dataDir));
});

test('attachments remain available after many text-only turns and omission warnings survive empty context', async t => {
  const { store } = await fixture(t);
  const attachments = await store.save(chatId, [{ name: '이전.csv', bytes: Buffer.from('수량,12') }]);
  const messages = [{ role: 'user', attachments }, ...Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '후속 대화' }))];
  assert.equal((await store.forTurn(chatId, [], messages)).inputs[0]?.text, '수량,12');
  assert.match(attachmentContext([], '이전 첨부 2개가 제외되었습니다.'), /이전 첨부 2개/);
});

test('image uploads reject truncated headers, corrupt payloads and excessive decoded dimensions', async t => {
  const { store } = await fixture(t);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(100000, 16);
  const corrupt = Buffer.concat([png.subarray(0, 33), Buffer.alloc(16), png.subarray(-12)]);
  for (const [name, bytes] of [['잘린.png', png.subarray(0, 8)], ['잘린.jpg', Buffer.from([255, 216, 255])], ['잘린.webp', Buffer.from('RIFF0000WEBP')], ['손상.png', png.subarray(0, 40)], ['깨진데이터.png', corrupt], ['초대형.png', oversized]]) {
    await assert.rejects(store.save(chatId, [{ name, bytes }]), /이미지|형식/);
  }
});

test('complete PNG, JPEG and WebP images decode before storage and corrupt JPEG/WebP data is rejected', async t => {
  const { store } = await fixture(t), { createCanvas } = await import('@napi-rs/canvas'), canvas = createCanvas(16, 12);
  canvas.getContext('2d').fillRect(0, 0, 16, 12);
  for (const [extension, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = canvas.toBuffer(mimeType);
    const [uploaded] = await store.save(chatId, [{ name: `정상.${extension}`, bytes }]);
    assert.equal(uploaded.mimeType, mimeType);
    if (extension !== 'png') await assert.rejects(store.save(chatId, [{ name: `손상.${extension}`, bytes: bytes.subarray(0, bytes.length - 8) }]), /이미지|형식/);
  }
});

test('all PDF files in an upload share one 60-second deadline and cancellation rolls back the batch', async t => {
  const { dataDir } = await fixture(t), timeoutCalls = [], signals = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeoutCalls.push(milliseconds); return originalTimeout(milliseconds); });
  const pdfResult = { content: 'PDF text', pages: 1, pagesRead: 1, images: [{ mimeType: 'image/jpeg', data: Buffer.from('preview').toString('base64') }] };
  const store = await createChatAttachments({ dataDir, pdfReader: async (_bytes, signal) => { signals.push(signal); return pdfResult; } });
  const files = ['a.pdf', 'b.pdf'].map(name => ({ name, bytes: Buffer.from('%PDF-fixture') }));
  await store.save(chatId, files);
  assert.deepEqual(timeoutCalls, [60000]); assert.equal(signals[0], signals[1]);
  const abort = new AbortController(); let calls = 0;
  const cancelled = await createChatAttachments({ dataDir, pdfReader: async () => { calls++; abort.abort(); return pdfResult; } });
  await assert.rejects(cancelled.save(otherId, files, { signal: abort.signal }), /취소|시간/);
  assert.equal(calls, 1); assert.deepEqual(await readdir(join(dataDir, 'chat-attachments', otherId)), []);
});
