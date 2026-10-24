import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChatConnections, parseConnectionCommand } from '../public/chat-connections.js';

const TEST_API_KEY = 'a-private-key';

class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: {}, dataset: {}, value: '', checked: false, disabled: false, textContent: '' }); this.classList = { toggle() {} }; if (tag === 'textarea') Object.defineProperty(this, 'type', { get: () => 'textarea' }); }
  append(...items) { this.children.push(...items); for (const item of items) item.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return all(this).filter(item => ['input', 'button', 'textarea'].includes(item.tagName)); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.listeners.click?.(); }
  set innerHTML(_) { assert.fail('Unsafe HTML'); }
}
const all = node => [node, ...node.children.flatMap(all)];
const content = node => all(node).map(item => item.textContent).join(' ');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, { browser = true, configured = false } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const root = new Element(), requests = [], pending = [], notices = [];
  let busy = false, changed = 0;
  globalThis.document = { body: root, createElement: tag => new Element(tag), getElementById: () => root };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/references') ? { vworld: { configured } } : url.endsWith('/test') ? { ok: true } : {} }) };
  };
  t.after(() => Object.assign(globalThis, previous));
  const ui = createChatConnections({ isBusy: () => busy, onPending: value => pending.push(value), onChange: () => { changed++; }, notify: value => notices.push(value) });
  ui.update({ desktop: true, browser });
  const field = name => { const item = all(root).find(item => item.dataset.field === name); assert.ok(item, name); return item; };
  const click = name => field(name).listeners.click?.();
  const submit = () => all(root).find(item => item.tagName === 'form').listeners.submit({ preventDefault() {} });
  return { ui, root, field, click, submit, requests, pending, notices, changed: () => changed, busy: value => { busy = value; ui.sync(); } };
}

test('connection commands keep ordinary CAD, URLs, standards research and explicit REA installation on the agent path', () => {
  for (const value of ['사각형을 그려줘', 'https://github.com/example/mcp 설치해줘', 'REA MCP 연결해줘', 'KDS 옹벽 기준을 검색해줘', '지형도 표고 삽입해줘']) assert.equal(parseConnectionCommand(value), null);
  assert.deepEqual(parseConnectionCommand('/mcp'), { kind: 'mcp', config: '' });
  assert.deepEqual(parseConnectionCommand('/mcp add {"url":"https://example.org"}'), { kind: 'mcp', config: '{"url":"https://example.org"}' });
  for (const value of ['/api', '/api vworld', 'API 등록해줘', 'VWorld API 연결해줘', '브이월드 API를 추가해주세요']) assert.deepEqual(parseConnectionCommand(value), { kind: 'vworld' });
  assert.deepEqual(parseConnectionCommand('지형 원본 등록해줘'), { kind: 'terrain' });
  assert.deepEqual(parseConnectionCommand('설계 기준 연결해줘'), { kind: 'standards' });
  assert.deepEqual(parseConnectionCommand('/mcp remove example'), { kind: 'manage', action: 'remove', name: 'example' });
  assert.equal(parseConnectionCommand('/mcp remove ../../secret'), null);
});

test('private MCP registration stays in chat, requires current trust and clears config before POST', async t => {
  const { ui, root, field, submit, requests, pending, changed } = setup(t);
  const raw = '{"mcpServers":{"custom":{"command":"node","env":{"TOKEN":"private-token"}}}}';
  assert.equal(ui.handleCommand(`/mcp add ${raw}`), true);
  assert.equal(field('config').value, raw);
  await submit(); assert.equal(requests.length, 0); assert.match(content(root), /신뢰/);
  field('trusted').checked = true; field('trusted').listeners.change();
  let release;
  globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); assert.equal(field('config').value, ''); return new Promise(resolve => { release = resolve; }); };
  const saving = submit();
  assert.equal(field('trusted').checked, false); assert.equal(field('save').disabled, true);
  await submit(); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/desktop/mcp/save');
  assert.deepEqual(JSON.parse(requests[0].body), { config: JSON.parse(raw), trusted: true });
  release({ ok: true, json: async () => ({ ok: true, data: {} }) }); await saving;
  assert.equal(changed(), 1); assert.deepEqual(pending, [true, false]);
  assert.doesNotMatch(content(root), /private-token/);
  assert.match(content(root), /등록.*연결.*확인/);
});

test('MCP edits revoke trust, invalid JSON and failed saves never echo config or server errors', async t => {
  const { ui, root, field, submit, requests } = setup(t);
  ui.handleCommand('/mcp'); field('trusted').checked = true;
  field('config').listeners.input(); assert.equal(field('trusted').checked, false);
  for (const value of ['{broken', '[]', 'null']) {
    field('config').value = value; field('trusted').checked = true; await submit();
    assert.equal(requests.length, 0); assert.match(content(root), /JSON 객체/);
  }
  field('config').value = '{"private-token":"secret"}'; field('trusted').checked = true;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'private-token secret /private/path' }) });
  await submit(); assert.match(content(root), /실패/); assert.doesNotMatch(content(root), /private-token|private\/path/);
});

test('VWorld key and test have separate single-use consent and never go through AI requests', async t => {
  const { ui, root, field, submit, click, requests } = setup(t, { configured: true });
  ui.handleCommand('VWorld API 연결해줘'); await flush();
  assert.equal(field('apiKey').type, 'password'); assert.equal(field('apiKey').autocomplete, 'off');
  assert.match(content(root), /VWorld.*채팅 기록.*AI/);
  assert.match(content(root), /연결 미확인/);
  field('apiKey').value = TEST_API_KEY; await submit();
  assert.equal(requests.filter(item => item.method === 'POST').length, 0);
  field('saveConsent').checked = true; field('domain').value = 'https://example.org';
  await submit(); assert.equal(field('apiKey').value, ''); assert.equal(field('saveConsent').checked, false);
  const post = requests.find(item => item.url.endsWith('/save'));
  assert.deepEqual(JSON.parse(post.body), { apiKey: TEST_API_KEY, domain: 'https://example.org' });
  assert.match(content(root), /저장.*실제 연결/);
  await click('test'); assert.equal(requests.filter(item => item.url.endsWith('/test')).length, 0);
  field('testConsent').checked = true; field('testConsent').listeners.change(); await click('test');
  assert.equal(field('testConsent').checked, false); assert.match(content(root), /실제 연결.*확인/);
  assert.equal(requests.filter(item => item.url.endsWith('/test')).length, 1);
  assert.ok(requests.every(item => !item.url.includes('/api/chat')));
  assert.doesNotMatch(content(root), /a-private-key/);
  field('apiKey').value = 'another-key'; field('saveConsent').checked = field('testConsent').checked = true;
  field('apiKey').listeners.input(); assert.equal(field('saveConsent').checked, false); assert.equal(field('testConsent').checked, false);
  ui.clear(); assert.equal(fieldValue(root, 'apiKey'), undefined);
});
const fieldValue = (root, name) => all(root).find(item => item.dataset.field === name)?.value;

test('VWorld validation, busy and cancellation keep credentials private', async t => {
  const { ui, root, field, submit, click, requests, busy } = setup(t);
  ui.handleCommand('/api'); await flush();
  assert.equal(field('test').disabled, true);
  field('saveConsent').checked = true; field('apiKey').value = 'short'; await submit();
  assert.match(content(root), /API 키/); assert.equal(requests.filter(item => item.method).length, 0);
  field('apiKey').value = 'valid-key'; field('domain').value = 'https://bad domain'; await submit();
  assert.equal(requests.filter(item => item.method).length, 0);
  field('domain').value = ''; busy(true); await submit(); assert.equal(requests.filter(item => item.method).length, 0);
  assert.equal(ui.handleCommand('/mcp'), true); assert.equal(field('apiKey').value, 'valid-key');
  busy(false); await click('cancel'); assert.equal(root.children.length, 0); assert.equal(fieldValue(root, 'apiKey'), undefined);
  ui.update({ desktop: false }); assert.equal(ui.handleCommand('/api'), true); assert.equal(root.children.length, 0);
  assert.equal(ui.handleCommand('일반 도면 수정'), false);
});

test('VWorld backend failures are sanitized and failed status is not connected', async t => {
  const { ui, root, field, submit, click } = setup(t, { configured: true });
  ui.handleCommand('/api vworld'); await flush();
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ ok: true, data: url.endsWith('/test') ? { ok: false } : {} }) });
  field('testConsent').checked = true; await click('test'); assert.match(content(root), /연결 확인 실패/);
  globalThis.fetch = async () => { throw Error('private-key /private/path'); };
  field('apiKey').value = TEST_API_KEY; field('saveConsent').checked = true; await submit();
  assert.match(content(root), /실패/); assert.doesNotMatch(content(root), /private-key|private\/path/);
  field('testConsent').checked = true; await click('test'); assert.match(content(root), /실패/);
  await click('remove'); assert.match(content(root), /실패/);
  ui.handleCommand('/api'); await flush(); assert.match(content(root), /실패/);
});

test('VWorld removal is an explicit chat-card operation', async t => {
  const { ui, root, click, requests } = setup(t, { configured: true });
  ui.handleCommand('/api'); await flush(); await click('remove');
  assert.ok(requests.some(item => item.url.endsWith('/references/remove')));
  assert.match(content(root), /해제/);
});

test('VWorld initial metadata blocks edits until it arrives and cannot overwrite a newer card', async t => {
  const { ui, field, submit, click, requests } = setup(t);
  let release;
  globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
  ui.handleCommand('/api');
  assert.equal(field('apiKey').disabled, true); assert.equal(field('domain').disabled, true);
  field('apiKey').value = 'valid-key'; field('saveConsent').checked = true;
  await submit(); await click('remove'); assert.equal(requests.length, 0);
  ui.handleCommand('/mcp');
  release({ ok: true, json: async () => ({ ok: true, data: { vworld: { configured: true, domain: 'old.example' } } }) });
  await flush(); assert.equal(field('config').value, '');
});

test('missing VWorld credentials request a private popup once after the current task finishes', async t => {
  const { ui, root, field, requests, busy } = setup(t);
  busy(true);
  ui.update({ desktop: true, credentialRequest: { id: 'request-1', provider: 'vworld' }, active: true });
  assert.equal(all(root).filter(item => item.tagName === 'dialog').length, 0);
  busy(false);
  ui.update({ desktop: true, credentialRequest: { id: 'request-1', provider: 'vworld' }, active: false });
  await flush();
  const dialog = all(root).find(item => item.tagName === 'dialog');
  assert.equal(dialog.open, true); assert.match(content(dialog), /VWorld API 등록/);
  field('apiKey').value = 'unsaved-private-key';
  dialog.listeners.cancel({ preventDefault() {} });
  assert.equal(dialog.open, false); assert.equal(dialog.parent.children.includes(dialog), false);
  ui.update({ desktop: true, credentialRequest: { id: 'request-1', provider: 'vworld' }, active: false });
  assert.equal(all(root).filter(item => item.tagName === 'dialog').length, 0);
  assert.equal(requests.filter(item => item.method === 'POST').length, 0);
  ui.update({ desktop: true, credentialRequest: { id: 'request-2', provider: 'vworld' }, active: false });
  assert.equal(all(root).find(item => item.tagName === 'dialog').open, true);
  ui.clear();
});

test('MCP maintenance only executes after the chat confirmation button', async t => {
  const { ui, root, click, requests } = setup(t);
  for (const [command, path, body] of [
    ['remove', 'remove', { name: 'custom' }], ['enable', 'toggle', { name: 'custom', enabled: true }],
    ['disable', 'toggle', { name: 'custom', enabled: false }], ['test', 'test', { name: 'custom' }],
  ]) {
    const count = requests.length; ui.handleCommand(`/mcp ${command} custom`); assert.equal(requests.length, count);
    await click('confirm'); assert.equal(requests.at(-1).url, `/api/desktop/mcp/${path}`); assert.deepEqual(JSON.parse(requests.at(-1).body), body);
  }
  assert.match(content(root), /연결.*확인/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { tested: true } }) });
  ui.handleCommand('/mcp test custom'); await click('confirm'); assert.match(content(root), /연결을 확인했습니다/);
});

test('manual terrain registration uses the existing local upload route and honors size limits', async t => {
  const { ui, root, field, requests } = setup(t);
  ui.handleCommand('지형 원본 등록해줘');
  const input = field('files'); assert.match(input.accept, /\.geojson/);
  input.files = []; await input.listeners.change(); assert.equal(requests.length, 0);
  input.files = [{ size: 129 * 1024 * 1024 }]; await input.listeners.change(); assert.match(content(root), /128MiB/); assert.equal(requests.length, 0);
  input.files = [new File(['{}'], 'source.geojson')]; await input.listeners.change();
  assert.equal(requests[0].url, '/api/local/terrain/import'); assert.ok(requests[0].body instanceof FormData);
  assert.match(content(root), /등록했습니다/);
  globalThis.fetch = async () => { throw Error('/private/path'); };
  input.files = [new File(['{}'], 'source.geojson')]; await input.listeners.change(); assert.match(content(root), /실패/); assert.doesNotMatch(content(root), /private\/path/);
});

test('native terrain picker and standards guidance are not external connection registrations', async t => {
  const { ui, root, click, requests } = setup(t, { browser: false });
  ui.handleCommand('설계 기준 연결해줘'); assert.match(content(root), /별도 MCP.*API.*필요하지 않습니다/); assert.equal(requests.length, 0);
  ui.handleCommand('지형 원본 등록해줘');
  globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: { cancelled: true } }) }; };
  await click('import'); assert.match(content(root), /취소/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  await click('import'); assert.match(content(root), /등록했습니다/);
});

test('app intercepts private connection cards before chat/history and clears them when chats change', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const submit = app.slice(app.indexOf('async function submitMessage('));
  assert.ok(submit.indexOf('chatConnections.handleCommand(message)') < submit.indexOf("appendMessage('user', message)"));
  assert.match(app, /onSelect\(chat\)\s*\{\s*chatConnections.clear\(\)/);
  assert.match(app, /chatConnections.update\(body.data\)/);
  assert.match(app, /chatConnections.clear\(\);[\s\S]*stopBridge\?\.\(\)/);
  assert.doesNotMatch(app, /mcpSettings.handleCommand/);
});
