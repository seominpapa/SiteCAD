import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRuntime, readChatStream } from '../public/chat-runtime.js';

const TEST_PRIVATE_TOKEN = 'private-token';

class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: {}, value: '', textContent: '', hidden: false, disabled: false, open: false }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  set innerHTML(_) { assert.fail('Unsafe HTML'); }
}

function fixture(t) {
  const prior = { document: globalThis.document, fetch: globalThis.fetch };
  const names = ['model-choice', 'model-dialog', 'model-select', 'model-description', 'models-refresh', 'model-apply', 'model-notice', 'chat-live', 'chat-live-tools', 'chat-live-text', 'chat-live-status'];
  const ids = Object.fromEntries(names.map(name => [name, new Element()]));
  const requests = [], errors = []; let busy = false, changes = 0;
  globalThis.document = { getElementById: name => { assert.ok(ids[name], name); return ids[name]; }, createElement: tag => new Element(tag) };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, data: { defaultModel: 'default-model', models: [
      { id: 'default-model', displayName: '기본 모델', description: '계정의 기본 모델', isDefault: true },
      { id: 'other-model', displayName: '<img onerror=attack()>', description: '<script>모델 설명</script>' },
    ] } });
  };
  t.after(() => Object.assign(globalThis, prior));
  const ui = createChatRuntime({ isBusy: () => busy, onError: message => errors.push(message), onChange: () => { changes++; } });
  const update = value => ui.update({ desktop: true, oauth: { connected: true }, ...value });
  return { ids, ui, update, requests, errors, changes: () => changes, busy: value => { busy = value; ui.sync(); } };
}

function responseFor(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}
const encode = records => records.map(value => JSON.stringify(value)).join('\n') + '\n';

test('model catalog loads only on request and applying a safe entry affects subsequent chat selection', async t => {
  const { ui, ids, update, requests, changes } = fixture(t);
  update({ runtime: { model: 'default-model' } });
  assert.equal(requests.length, 0); assert.equal(ui.selectedModel(), undefined);
  await ids['model-choice'].listeners.click();
  assert.equal(ids['model-dialog'].open, true);
  assert.equal(requests[0].url, '/api/desktop/models'); assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(ids['model-select'].value, 'default-model');
  ids['model-select'].value = 'other-model'; ids['model-select'].listeners.change();
  assert.equal(ids['model-description'].textContent, '<script>모델 설명</script>');
  assert.equal(ids['model-select'].children[1].textContent, '<img onerror=attack()>');
  await ids['model-apply'].listeners.click();
  assert.equal(ui.selectedModel(), 'other-model'); assert.equal(ids['model-dialog'].open, false);
  assert.equal(changes(), 1); assert.equal(requests.length, 1);
  assert.match(ids['model-choice'].textContent, /<img onerror=attack\(\)>/);
});

test('model controls respect authentication and busy state without changing the existing selection', async t => {
  const { ui, ids, update, busy, requests } = fixture(t);
  ui.update({ desktop: false }); assert.equal(ids['model-choice'].hidden, true);
  ui.update({ desktop: true, oauth: { connected: false } });
  await ids['model-choice'].listeners.click(); assert.equal(requests.length, 0);
  update(); busy(true);
  await ids['model-choice'].listeners.click(); assert.equal(requests.length, 0);
  busy(false); await ids['model-choice'].listeners.click();
  ids['model-select'].value = 'other-model'; busy(true);
  await ids['model-apply'].listeners.click(); assert.equal(ui.selectedModel(), undefined);
  busy(false); await ids['model-apply'].listeners.click(); assert.equal(ui.selectedModel(), 'other-model');
});

test('catalog refresh failures and removed models never silently choose a replacement', async t => {
  const { ui, ids, update, errors } = fixture(t); update();
  await ids['model-choice'].listeners.click();
  ids['model-select'].value = 'other-model'; await ids['model-apply'].listeners.click();
  globalThis.fetch = async () => { throw Error('/private/token'); };
  await ids['models-refresh'].listeners.click();
  assert.equal(ui.selectedModel(), 'other-model'); assert.match(ids['model-notice'].textContent, /불러오지 못/);
  assert.doesNotMatch(ids['model-notice'].textContent, /private|token/);
  globalThis.fetch = async () => Response.json({ ok: true, data: { models: [{ id: 'default-model', displayName: '기본 모델', isDefault: true }], defaultModel: 'default-model' } });
  await ids['models-refresh'].listeners.click();
  assert.equal(ui.selectedModel(), 'other-model'); assert.match(ids['model-notice'].textContent, /다시 선택/);
  assert.equal(ids['model-apply'].disabled, true); assert.equal(errors.length, 0);
  ids['model-select'].value = 'default-model'; ids['model-select'].listeners.change();
  await ids['model-apply'].listeners.click(); assert.equal(ui.selectedModel(), 'default-model');
});

test('a loading catalog locks changes and safely rejects empty, invalid and duplicate entries', async t => {
  const { ui, ids, update } = fixture(t); update();
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = ids['model-choice'].listeners.click();
  assert.equal(ids['model-select'].disabled, true); assert.equal(ids['model-apply'].disabled, true);
  release(Response.json({ ok: true, data: { models: [{ id: '' }, { id: 'same', displayName: 'First' }, { id: 'same', displayName: 'Duplicate' }, { id: 'bad\u0000id' }] } }));
  await pending;
  assert.equal(ids['model-select'].children.length, 1); assert.equal(ids['model-select'].children[0].textContent, 'First');
  globalThis.fetch = async () => Response.json({ ok: false, error: '/private/path' });
  await ids['models-refresh'].listeners.click(); assert.doesNotMatch(ids['model-notice'].textContent, /private/);
});

test('live rendering appends public text and tracks parallel tools by id without rendering arguments or reasoning', t => {
  const { ui, ids } = fixture(t); ui.begin();
  ui.event({ type: 'connected', model: 'default-model' });
  ui.event({ type: 'delta', text: '한글 <script>한 줄</script>' });
  ui.event({ type: 'reasoning', text: 'private reasoning' });
  ui.event({ type: 'tool', id: 'call-1', server: 'sitecad', name: 'cad_query', status: 'running', arguments: { apiKey: 'private-key' } });
  ui.event({ type: 'tool', id: 'call-2', server: 'sitecad', name: 'cad_query', status: 'running' });
  ui.event({ type: 'tool', id: 'call-1', server: 'sitecad', name: 'cad_query', status: 'completed' });
  assert.equal(ids['chat-live-text'].textContent, '한글 <script>한 줄</script>');
  assert.equal(ids['chat-live-tools'].children.length, 2);
  assert.match(ids['chat-live-tools'].children[0].textContent, /sitecad.*cad_query.*완료/);
  assert.match(ids['chat-live-tools'].children[1].textContent, /실행 중/);
  assert.doesNotMatch(JSON.stringify(ids['chat-live-tools']), /private-key|reasoning/);
  ui.event({ type: 'tool', id: 'call-2', server: 'sitecad', name: 'cad_query', status: 'failed' });
  assert.match(ids['chat-live-tools'].children[1].textContent, /실패/);
  ui.finish(); assert.equal(ids['chat-live'].hidden, true);
  ui.event({ type: 'delta', text: 'late' }); assert.equal(ids['chat-live-text'].textContent.includes('late'), false);
});

test('failed streams keep partial visible output and bounded tool display until a new request begins', t => {
  const { ui, ids } = fixture(t); ui.begin(); ui.event({ type: 'delta', text: '부분 답변' });
  for (let i = 0; i < 129; i++) ui.event({ type: 'tool', id: `call-${i}`, name: 'cad_query', status: 'running' });
  assert.equal(ids['chat-live-tools'].children.length, 128);
  ui.fail('연결 중단');
  assert.equal(ids['chat-live'].hidden, false); assert.equal(ids['chat-live-text'].textContent, '부분 답변');
  assert.match(ids['chat-live-status'].textContent, /연결 중단/);
  ui.begin(); assert.equal(ids['chat-live-text'].textContent, ''); assert.equal(ids['chat-live-tools'].children.length, 0);
  assert.throws(() => ui.event({ type: 'delta', text: 'x'.repeat(256 * 1024 + 1) }), /답변.*크기/);
});

test('NDJSON reader preserves split UTF-8 and emits public events before returning the final result', async () => {
  const records = [{ type: 'delta', text: '안녕하세요' }, { type: 'tool', id: 'query', server: 'sitecad', name: 'cad_query', status: 'completed' }, { type: 'result', data: { reply: '완료', executed: true } }];
  const seen = [];
  const result = await readChatStream(responseFor(encode(records), 1), value => seen.push(value));
  assert.deepEqual(seen, records.slice(0, -1)); assert.equal(result.reply, '완료');
});

test('NDJSON reader forwards only public event fields and accepts a complete final line without a newline', async () => {
  const seen = [];
  const source = encode([
    { type: 'connected', model: 'account-model', token: TEST_PRIVATE_TOKEN },
    { type: 'tool', id: 'call', server: 'sitecad', name: 'cad_query', status: 'completed', arguments: { key: 'private-key' }, result: { path: '/private/path' } },
  ]) + JSON.stringify({ type: 'result', data: { reply: 'done' } });
  await readChatStream(responseFor(source), value => seen.push(value));
  assert.deepEqual(seen, [{ type: 'connected', model: 'account-model' }, { type: 'tool', id: 'call', server: 'sitecad', name: 'cad_query', status: 'completed' }]);
  assert.doesNotMatch(JSON.stringify(seen), /private/);
});

test('NDJSON reader rejects truncated, malformed, duplicate and post-terminal responses without retrying', async () => {
  for (const source of [
    encode([{ type: 'delta', text: '부분' }]),
    '{invalid}\n',
    encode([{ type: 'result', data: {} }, { type: 'result', data: {} }]),
    encode([{ type: 'result', data: {} }, { type: 'delta', text: 'late' }]),
    encode([{ type: 'result', data: null }]),
    encode([{ type: 'reasoning', text: 'internal' }, { type: 'result', data: {} }]),
  ]) await assert.rejects(readChatStream(responseFor(source), () => {}), /스트림|응답/);
  await assert.rejects(readChatStream(new Response('denied', { status: 403 }), () => {}), /응답/);
  await assert.rejects(readChatStream({ ok: true, body: null }, () => {}), /스트림/);
});

test('NDJSON reader reports explicit and transport failures while releasing its reader', async () => {
  await assert.rejects(readChatStream(responseFor(encode([{ type: 'error', message: '작업을 취소했습니다.' }])), () => {}), /취소/);
  const response = new Response(new ReadableStream({ start(controller) { controller.error(Error('connection lost')); } }));
  await assert.rejects(readChatStream(response, () => {}), /connection lost/);
  assert.equal(response.body.locked, false);
  const consumerFailure = responseFor(encode([{ type: 'delta', text: 'text' }, { type: 'result', data: {} }]));
  await assert.rejects(readChatStream(consumerFailure, () => { throw Error('consumer failed'); }), /consumer failed/);
  assert.equal(consumerFailure.body.locked, false);
});

test('NDJSON reader enforces bounded lines, events and total reply bytes', async () => {
  await assert.rejects(readChatStream(responseFor('x'.repeat(2 * 1024 * 1024 + 1), 2 * 1024 * 1024), () => {}), /크기/);
  await assert.rejects(readChatStream(responseFor(encode([{ type: 'delta', text: 'x'.repeat(256 * 1024 + 1) }, { type: 'result', data: {} }]), 512 * 1024), () => {}), /답변.*크기/);
  const many = encode([...Array.from({ length: 10001 }, () => ({ type: 'tool', id: 'x', name: 'tool', status: 'completed' })), { type: 'result', data: {} }]);
  await assert.rejects(readChatStream(responseFor(many, 1024 * 1024), () => {}), /횟수/);
});
