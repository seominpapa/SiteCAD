import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChatConnections, parseConnectionCommand } from '../public/chat-connections.js';


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
function setup(t, { browser = true, configured = false, kcsc = { configured: false, installed: false, connected: false } } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const root = new Element(), requests = [], pending = [], notices = [], opened = [];
  let busy = false, changed = 0;
  globalThis.document = { body: root, createElement: tag => new Element(tag), getElementById: () => root };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/references') ? { vworld: { configured } } : url.endsWith('/kcsc') ? kcsc : url.endsWith('/test') ? { ok: true } : {} }) };
  };
  t.after(() => Object.assign(globalThis, previous));
  const ui = createChatConnections({ isBusy: () => busy, onPending: value => pending.push(value), onChange: () => { changed++; }, notify: value => notices.push(value), onOpenSettings: (tab,id) => opened.push([tab,id]) });
  ui.update({ desktop: true, browser });
  const field = name => { const item = all(root).find(item => item.dataset.field === name); assert.ok(item, name); return item; };
  const click = name => field(name).listeners.click?.();
  const submit = () => all(root).find(item => item.tagName === 'form').listeners.submit({ preventDefault() {} });
  return { ui, root, field, click, submit, requests, pending, notices, opened, changed: () => changed, busy: value => { busy = value; ui.sync(); } };
}

test('ordinary installation URLs and ambiguous API registration remain agent requests', () => {
  for (const value of ['사각형을 그려줘','https://github.com/example/mcp 설치해줘','REA MCP 연결해줘','API 등록해줘','https://github.com/lhs1152-lgtm/kcsc-design-mcp 설치해줘','KDS 옹벽 기준을 검색해줘']) assert.equal(parseConnectionCommand(value),null);
  assert.deepEqual(parseConnectionCommand('/api'),{kind:'api'});
  assert.deepEqual(parseConnectionCommand('/mcp'),{kind:'mcp'});
  assert.deepEqual(parseConnectionCommand('/api kcsc'),{kind:'kcsc'});
  assert.deepEqual(parseConnectionCommand('/api vworld'),{kind:'vworld'});
  assert.equal(parseConnectionCommand('/mcp remove ../../secret'),null);
});

test('known API guidance links to issuance and settings instead of another key popup',async t=>{
  const {ui,root,click,requests,opened}=setup(t);
  for(const [command,id,url] of [['/api kcsc','kcsc','https://kcsc.re.kr/support/api'],['VWorld API 연결해줘','vworld','https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do']]){
    ui.handleCommand(command);assert.match(content(root),/채팅.*키.*입력하지/);
    assert.ok(all(root).some(item=>item.href===url));
    assert.ok(!all(root).some(item=>item.tagName==='dialog'||item.type==='password'||item.tagName==='textarea'));
    await click('open-settings');assert.deepEqual(opened.at(-1),['api',id]);
  }
  assert.equal(requests.length,0);
});

test('MCP slash guidance never renders or forwards JSON credentials',async t=>{
  const {ui,root,click,requests,opened}=setup(t);
  ui.handleCommand('/mcp add {"env":{"TOKEN":"private-token"}}');
  assert.doesNotMatch(content(root),/private-token/);
  assert.match(content(root),/채팅.*주소/);
  await click('open-settings');assert.deepEqual(opened.at(-1),['mcp',undefined]);
  assert.equal(requests.length,0);
});

test('credentials wait until completion then offer the matching settings item once',async t=>{
  const {ui,root,click,opened,busy}=setup(t);
  busy(true);ui.update({desktop:true,active:true,credentialRequest:{id:'req1',provider:'vworld'}});assert.equal(root.children.length,0);
  busy(false);ui.update({desktop:true,active:false,credentialRequest:{id:'req1',provider:'vworld'}});
  await click('open-settings');assert.deepEqual(opened.at(-1),['api','vworld']);
  ui.clear();ui.update({desktop:true,active:false,credentialRequest:{id:'req1',provider:'vworld'}});assert.equal(root.children.length,0);
  ui.update({desktop:true,active:false,credentialRequest:{id:'req2',provider:'api',apiId:'weather',name:'날씨 API',issuanceUrl:'javascript:alert(1)'}});
  await click('open-settings');assert.deepEqual(opened.at(-1),['api','weather']);
  assert.ok(!all(root).some(item=>item.href?.startsWith('javascript:')));
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

test('missing MCP credentials guide the same API tab with a private MCP target',async t=>{
  const {ui,root,click,opened}=setup(t);
  ui.update({desktop:true,active:false,credentialRequest:{id:'mcp-1',provider:'mcp',apiId:'weather',name:'날씨 MCP',issuanceUrl:'https://weather.example/keys'}});
  assert.match(content(root),/날씨 MCP/);assert.match(content(root),/환경 변수.*Bearer/);
  await click('open-settings');assert.deepEqual(opened.at(-1),['api','mcp-weather']);
  assert.ok(!all(root).some(item=>item.type==='password'));
});
