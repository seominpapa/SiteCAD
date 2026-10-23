import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendProvenance, createMcpSettings, parseMcpCommand, safeSourceUrl } from '../public/mcp-settings.js';

class Element {
  constructor(tag = 'div') {
    Object.assign(this, { tagName: tag, children: [], listeners: {}, dataset: {}, value: '', textContent: '', hidden: false, checked: false, disabled: false, open: false });
    this.classList = { toggle() {} };
  }
  set innerHTML(_) { throw Error('Untrusted HTML must never render.'); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...items) { this.children.push(...items); for (const item of items) item.parent = this; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  focus() {}
  querySelectorAll() { return []; }
}

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, referenceState = { configured: false }) {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [];
  ids['mcp-dialog'].querySelectorAll = () => [ids['terrain-import'], ids['mcp-refresh'], ids['mcp-rea-preset'], ids['mcp-config'], ids['mcp-trusted'], ids['vworld-api-key'], ids['vworld-domain'], ids['vworld-save-consent'], ids['vworld-test-consent'], ids['vworld-test'], ids['vworld-remove'], ...ids['mcp-server-list'].children.flatMap(card => card.children.at(-1)?.children || [])];
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: tag => new Element(tag) };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url.endsWith('/terrain')) return { ok: true, json: async () => ({ ok: true, data: { datasets: [] } }) };
    if (url.endsWith('/references/save')) { const data = JSON.parse(options.body); referenceState = { configured: true, ...(data.domain ? { domain: data.domain } : {}) }; }
    if (url.endsWith('/references/remove')) referenceState = { configured: false };
    if (url.endsWith('/references/test')) return { ok: true, json: async () => ({ ok: true, data: { ok: true, checkedAt: '2026-10-22', message: '연결 확인' } }) };
    if (url.includes('/references')) return { ok: true, json: async () => ({ ok: true, data: { vworld: referenceState } }) };
    if (url.endsWith('/mcp/test')) return { ok: true, json: async () => ({ ok: true, data: { name: 'example', status: 'connected', tools: ['lookup'], tested: true } }) };
    return { ok: true, json: async () => ({ ok: true, data: {
      servers: [{ name: 'test-server', command: '/usr/local/bin/test', args: [], transport: 'stdio', enabled: true }],
      presets: { rea: { name: 'rea', preset: 'rea' } },
      presetDetails: { rea: { command: '/usr/local/bin/node', args: ['/project/rea/scripts/rea.mjs', 'mcp'] } },
    } }) };
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  return { ids, requests };
}

test('source links only allow absolute HTTPS addresses without credentials', () => {
  assert.equal(safeSourceUrl('https://example.org/reference'), 'https://example.org/reference');
  for (const url of ['javascript:alert(1)', 'data:text/html,attack', 'http://example.org', '/local', 'https://user:secret@example.org']) assert.equal(safeSourceUrl(url), null);
});

test('MCP commands request review locally and never turn ordinary chat into config', () => {
  assert.deepEqual(parseMcpCommand('/mcp add {"mcpServers":{}}'), { config: '{"mcpServers":{}}' });
  assert.deepEqual(parseMcpCommand('REA MCP 추가해줘'), { preset: 'rea' });
  assert.deepEqual(parseMcpCommand('REA MCP를 연결해주세요'), { preset: 'rea' });
  assert.deepEqual(parseMcpCommand('/mcp'), { config: '' });
  assert.equal(parseMcpCommand('REA로 웹에서 설계기준을 찾아줘'), null);
});

test('curated reference connection commands only open review sections', () => {
  assert.deepEqual(parseMcpCommand('VWorld API 연결해줘'), { reference: 'vworld' });
  assert.deepEqual(parseMcpCommand('브이월드 연결해줘'), { reference: 'vworld' });
  assert.deepEqual(parseMcpCommand('설계기준 연결해줘'), { reference: 'standards' });
  assert.deepEqual(parseMcpCommand('지형 원본 등록해줘'), { reference: 'terrain' });
  assert.equal(parseMcpCommand('등고선을 조회해서 도면에 넣어줘'), null);
  assert.equal(parseMcpCommand('https://data.example.org/contours.geojson 지형 원본 등록하고 도면에 넣어줘'), null);
  assert.equal(parseMcpCommand('VWorld에서 이 주소 좌표를 찾아줘'), null);
});

test('terrain registration opens a native file picker without passing paths or credentials through chat', async t => {
  const { ids, requests } = await fixture(t);
  const baseFetch = globalThis.fetch;
  let imported = false;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/terrain/import')) {
      requests.push({ url, ...options }); imported = true;
      return { ok: true, json: async () => ({ ok: true, data: { cancelled: false } }) };
    }
    if (url.endsWith('/terrain')) return { ok: true, json: async () => ({ ok: true, data: { datasets: imported ? [{ id: 'terrain-1', title: '<img src=x onerror=alert(1)>', originalCRS: 'EPSG:5186', verticalDatum: 'unknown' }] : [] } }) };
    return baseFetch(url, options);
  };
  let busy = false;
  const settings = createMcpSettings({ isBusy: () => busy, notify: assert.fail });
  settings.update({ desktop: true }); settings.handleCommand('지형 원본 등록해줘'); await flush();
  assert.match(ids['terrain-datasets'].children[0].textContent, /등록된 지형 원본이 없습니다/);
  assert.equal(requests.some(request => request.url.endsWith('/terrain/import')), false);
  busy = true; settings.sync();
  assert.equal(ids['terrain-import'].disabled, true);
  await ids['terrain-import'].listeners.click();
  assert.equal(imported, false);
  busy = false; settings.sync();
  await ids['terrain-import'].listeners.click();
  assert.deepEqual(JSON.parse(requests.find(request => request.url.endsWith('/terrain/import')).body), {});
  const label = ids['terrain-datasets'].children[0].textContent;
  assert.match(label, /<img src=x onerror=alert\(1\)>.*EPSG:5186/);
  assert.match(label, /표고 기준 미확인/);
  assert.match(ids['terrain-notice'].textContent, /등록/);
});

test('terrain picker cancellation and errors do not claim a successful import', async t => {
  const { ids } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true }); settings.handleCommand('지형 원본 등록해줘'); await flush();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { cancelled: true } }) });
  await ids['terrain-import'].listeners.click();
  assert.match(ids['terrain-notice'].textContent, /취소/);
  globalThis.fetch = async () => { throw Error('/private/secret/full/path'); };
  await ids['terrain-import'].listeners.click();
  assert.match(ids['terrain-notice'].textContent, /등록하지 못/);
  assert.doesNotMatch(ids['terrain-notice'].textContent, /private|secret/);
});

test('VWorld key save requires explicit consent and clears the password without claiming connection', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true });
  settings.handleCommand('VWorld API 연결해줘');
  await flush();
  assert.equal(ids['mcp-dialog'].open, true);
  assert.equal(ids['reference-vworld'].hidden, false);
  assert.equal(requests.some(request => request.method === 'POST'), false);
  const apiKey = randomUUID();
  ids['vworld-api-key'].value = apiKey;
  ids['vworld-form'].listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(requests.some(request => request.url.endsWith('/references/save')), false);
  ids['vworld-save-consent'].checked = true;
  ids['vworld-form'].listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(requests.find(request => request.url.endsWith('/references/save')).body), { apiKey });
  assert.equal(ids['vworld-api-key'].value, '');
  assert.match(ids['vworld-notice'].textContent, /저장/);
  assert.doesNotMatch(ids['vworld-notice'].textContent, /연결됨|연결 성공/);
  const allText = Object.values(ids).map(element => element.textContent).join(' ');
  assert.equal(allText.includes(apiKey), false);
});

test('VWorld real API test requires separate one-call consent and stays locked during chat', async t => {
  const { ids, requests } = await fixture(t, { configured: true });
  let busy = false;
  const settings = createMcpSettings({ isBusy: () => busy, notify: assert.fail });
  settings.update({ desktop: true });
  settings.handleCommand('VWorld API 연결해줘');
  await flush();
  await ids['vworld-test'].listeners.click();
  assert.equal(requests.some(request => request.url.endsWith('/references/test')), false);
  ids['vworld-test-consent'].checked = true;
  busy = true; settings.sync();
  assert.equal(ids['vworld-test'].disabled, true);
  await ids['vworld-test'].listeners.click();
  assert.equal(requests.some(request => request.url.endsWith('/references/test')), false);
  busy = false; settings.sync();
  await ids['vworld-test'].listeners.click();
  assert.equal(requests.filter(request => request.url.endsWith('/references/test')).length, 1);
  assert.equal(ids['vworld-test-consent'].checked, false);
  assert.match(ids['vworld-status'].textContent, /연결 확인됨/);
  assert.match(ids['vworld-notice'].textContent, /실제 연결을 확인/);
});

test('VWorld failed checks never claim connection and key removal clears local UI state', async t => {
  const { ids, requests } = await fixture(t, { configured: true, domain: 'https://example.org', lastCheck: { ok: false, checkedAt: '2026-10-22' } });
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => url.endsWith('/references/test')
    ? { ok: true, json: async () => ({ ok: true, data: { ok: false, checkedAt: '2026-10-22', message: '키 권한 확인 필요' } }) }
    : baseFetch(url, options);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true }); settings.handleCommand('VWorld API 연결해줘'); await flush();
  assert.equal(ids['vworld-domain'].value, 'https://example.org');
  assert.match(ids['vworld-status'].textContent, /연결 확인 실패/);
  ids['vworld-test-consent'].checked = true;
  await ids['vworld-test'].listeners.click();
  assert.match(ids['vworld-notice'].textContent, /실패/);
  assert.doesNotMatch(ids['vworld-status'].textContent, /연결 확인됨/);
  await ids['vworld-remove'].listeners.click();
  assert.ok(requests.some(request => request.url.endsWith('/references/remove')));
  assert.equal(ids['vworld-status'].textContent, '키 미등록');
  assert.equal(ids['vworld-domain'].value, '');
  assert.equal(ids['vworld-test'].disabled, true);
});

test('VWorld password and consent clear on input changes, save errors and dialog close', async t => {
  const { ids } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true }); settings.handleCommand('VWorld API 연결해줘'); await flush();
  ids['vworld-api-key'].value = 'example-private-key'; ids['vworld-save-consent'].checked = true;
  ids['vworld-api-key'].listeners.input();
  assert.equal(ids['vworld-save-consent'].checked, false);
  ids['vworld-save-consent'].checked = true;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: 'example-private-key must not appear' }) });
  ids['vworld-form'].listeners.submit({ preventDefault() {} }); await flush();
  assert.equal(ids['vworld-api-key'].value, '');
  assert.doesNotMatch(ids['vworld-notice'].textContent, /example-private-key/);
  assert.match(ids['vworld-notice'].textContent, /저장하지 못/);
  ids['vworld-api-key'].value = 'another-private-key';
  ids['mcp-dialog'].listeners.close();
  assert.equal(ids['vworld-api-key'].value, '');
});

test('pasted MCP settings require review and an explicit trust check before save', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true });
  const config = '{"mcpServers":{"test":{"command":"example","args":[]}}}';
  assert.equal(settings.handleCommand(`/mcp add ${config}`), true);
  await flush();
  assert.equal(ids['mcp-dialog'].open, true);
  assert.equal(ids['mcp-config'].value, config);
  assert.equal(ids['mcp-trusted'].checked, false);
  assert.equal(requests.some(request => request.method === 'POST'), false);
  ids['mcp-config-form'].listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(requests.some(request => request.url.endsWith('/mcp/save')), false);
  ids['mcp-trusted'].checked = true;
  ids['mcp-config-form'].listeners.submit({ preventDefault() {} });
  await flush();
  const saved = requests.find(request => request.url.endsWith('/mcp/save'));
  assert.deepEqual(JSON.parse(saved.body), { config: JSON.parse(config), trusted: true });
  assert.equal(ids['mcp-trusted'].checked, false);
});

test('REA preset opens untrusted review and editing config resets trust', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true });
  settings.handleCommand('REA MCP 추가해줘');
  await flush();
  assert.deepEqual(JSON.parse(ids['mcp-config'].value), { name: 'rea', preset: 'rea' });
  assert.equal(ids['mcp-preset-preview'].hidden, false);
  assert.match(ids['mcp-preset-command'].textContent, /\/usr\/local\/bin\/node/);
  assert.match(ids['mcp-preset-command'].textContent, /\/project\/rea\/scripts\/rea.mjs/);
  assert.equal(requests.some(request => request.method === 'POST'), false);
  ids['mcp-trusted'].checked = true;
  ids['mcp-config'].listeners.input();
  assert.equal(ids['mcp-trusted'].checked, false);
  assert.equal(ids['mcp-save'].disabled, true);
});

test('server connection, enable state and removal use explicit management actions', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true, externalMcp: { servers: [{ name: 'example', enabled: true, connected: true, transport: 'http', url: 'https://example.org/mcp', tools: ['lookup'] }] } });
  assert.match(ids['external-mcp-status'].textContent, /1 연결/);
  const actions = ids['mcp-server-list'].children[0].children.at(-1).children;
  await actions[0].listeners.click();
  assert.match(ids['mcp-notice'].textContent, /연결됨 · 도구 1개/);
  await actions[1].listeners.click();
  await actions[2].listeners.click();
  const posts = requests.filter(request => request.method === 'POST');
  assert.ok(posts[0].url.endsWith('/mcp/test'));
  assert.deepEqual(JSON.parse(posts[1].body), { name: 'example', enabled: false });
  assert.ok(posts[2].url.endsWith('/mcp/remove'));
  assert.deepEqual(JSON.parse(posts[2].body), { name: 'example' });
});

test('connection test does not claim success for failed or authentication-required inventory', async t => {
  const { ids } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  for (const [status, expected] of [['failed', /연결을 확인하지 못했습니다/], ['authenticationRequired', /인증이 필요합니다/], ['connected', /연결을 확인하지 못했습니다/]]) {
    globalThis.fetch = async url => ({ ok: true, json: async () => ({ ok: true, data: url.endsWith('/mcp/test')
      ? { name: 'test', status, tested: false, tools: [] }
      : { servers: [{ name: 'test', enabled: true, status, connected: status === 'connected', tools: [] }] } }) });
    settings.update({ desktop: true, externalMcp: { servers: [{ name: 'test', enabled: true, status }] } });
    await ids['mcp-server-list'].children[0].children.at(-1).children[0].listeners.click();
    assert.match(ids['mcp-notice'].textContent, expected);
    assert.match(ids['mcp-notice'].textContent, /도구 0개/);
    assert.doesNotMatch(ids['mcp-notice'].textContent, /연결됨/);
  }
});

test('invalid JSON and failed server responses stay visible without trusting a config', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true });
  ids['mcp-config'].value = '{broken'; ids['mcp-trusted'].checked = true;
  ids['mcp-config-form'].listeners.submit({ preventDefault() {} });
  await flush();
  assert.match(ids['mcp-notice'].textContent, /JSON/);
  assert.equal(requests.length, 0);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: '서버에 연결할 수 없습니다.' }) });
  await ids['mcp-refresh'].listeners.click();
  assert.equal(ids['mcp-notice'].textContent, '서버에 연결할 수 없습니다.');
});

test('MCP configuration cannot change while a chat is active', async t => {
  const { ids, requests } = await fixture(t);
  let busy = false;
  const settings = createMcpSettings({ isBusy: () => busy, notify: assert.fail });
  settings.update({ desktop: true, externalMcp: { servers: [{ name: 'blocked', enabled: false, transport: 'stdio', envKeys: ['EXAMPLE_TOKEN'], error: '연결 대기' }] } });
  const buttons = ids['mcp-server-list'].children[0].children.at(-1).children;
  assert.equal(buttons[0].disabled, true);
  busy = true; settings.sync();
  assert.equal(ids['manage-mcp'].disabled, true);
  assert.equal(ids['mcp-refresh'].disabled, true);
  assert.equal(buttons[1].disabled, true);
  await buttons[1].listeners.click();
  settings.handleCommand('/mcp add {}');
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(ids['mcp-dialog'].open, false);
});

test('MCP review reports unsupported desktop and missing presets without execution', async t => {
  const { ids, requests } = await fixture(t);
  const notices = [];
  const settings = createMcpSettings({ isBusy: () => false, notify: (...args) => notices.push(args) });
  settings.update({ desktop: false });
  settings.handleCommand('/mcp');
  assert.equal(notices.length, 1);
  assert.equal(requests.length, 0);
  settings.update({ desktop: true });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { servers: [] } }) });
  settings.handleCommand('REA MCP 추가해줘');
  await flush();
  assert.match(ids['mcp-notice'].textContent, /사전 설정을 찾지/);
  assert.equal(ids['mcp-save'].disabled, true);
});

test('external tools show bounded inputs and do not approve hidden arguments', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true, notify: assert.fail });
  settings.update({ desktop: true, approvals: [{ id: 'approval-1', server: 'rea', tool: 'inspect', arguments: { url: 'x'.repeat(10000) } }] });
  const card = ids['tool-approvals'].children[0];
  assert.equal(card.children[1].textContent, 'rea · inspect');
  assert.equal(card.children[2].textContent.length, 8000);
  assert.equal(requests.length, 0);
  assert.equal(card.children.at(-1).children[0].disabled, true);
  await card.children.at(-1).children[0].listeners.click();
  assert.equal(requests.length, 0);
  await card.children.at(-1).children[1].listeners.click();
  assert.deepEqual(JSON.parse(requests[0].body), { id: 'approval-1', approved: false });
  assert.equal(ids['tool-approvals'].hidden, true);
  settings.update({ desktop: true, approvals: [{ id: 'approval-2', server: 'rea', tool: 'inspect', arguments: { url: 'https://example.org' } }] });
  await ids['tool-approvals'].children[0].children.at(-1).children[0].listeners.click();
  assert.deepEqual(JSON.parse(requests[1].body), { id: 'approval-2', approved: true });
});

test('failed approval remains visible and expired approvals disappear on status refresh', async t => {
  const { ids } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true, notify: assert.fail });
  const approval = { id: 'failed', server: 'public-web', tool: 'fetch', arguments: 'https://example.org' };
  settings.update({ desktop: true, approvals: [approval] });
  settings.update({ desktop: true, approvals: [approval] });
  assert.equal(ids['tool-approvals'].children.length, 1);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: '승인 요청이 만료되었습니다.' }) });
  const card = ids['tool-approvals'].children[0];
  await card.children.at(-1).children[0].listeners.click();
  assert.equal(card.children[4].textContent, '승인 요청이 만료되었습니다.');
  assert.equal(card.children.at(-1).children[0].disabled, false);
  settings.update({ desktop: true, approvals: [] });
  assert.equal(ids['tool-approvals'].hidden, true);
});

test('reference and concept cards retain provenance and render untrusted text safely', async t => {
  await fixture(t);
  const article = new Element('article');
  appendProvenance(article, {
    sources: [{ id: 'S1', title: '<img onerror=attack()>', url: 'https://example.org/standard', sha256: 'abc123', retrievedAt: '2026-10-22' }, { id: 'S2', title: 'unsafe', url: 'javascript:attack()' }],
    design: { conceptual: true, title: '배수로', assumptions: ['<script>not html</script>'], dimensions: [{ name: '폭', value: 600, unit: 'mm', basis: 'assumption' }, { name: '높이', value: 400, unit: 'mm', basis: 'source', sourceId: 'S1' }], sourceIds: ['S1'] },
  });
  const all = [];
  const visit = node => { all.push(node); node.children.forEach(visit); };
  visit(article);
  const anchors = all.filter(node => node.tagName === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'https://example.org/standard');
  assert.match(anchors[0].rel, /noopener/);
  assert.ok(all.some(node => node.textContent === '폭: 600 mm · 가정값'));
  assert.ok(all.some(node => node.textContent === '높이: 400 mm · 출처 S1'));
  assert.ok(all.some(node => node.textContent === '<script>not html</script>'));
});

test('reference cards distinguish search snippets from partial PDF text extraction', async t => {
  await fixture(t);
  const article = new Element('article');
  appendProvenance(article, { sources: [
    { id: 'SEARCH1', kind: 'search', title: '검색 자료', url: 'https://example.org/search-result', snippet: '<img onerror=attack()> 검색 요약' },
    { id: 'PDF1', contentType: 'application/pdf', title: '기준 PDF', url: 'https://example.org/standard.pdf', pagesRead: 30, pages: 72, truncated: true, limitation: '<script>source limitation</script>' },
  ] });
  const texts = [];
  const visit = node => { texts.push(node.textContent); node.children.forEach(visit); };
  visit(article);
  assert.ok(texts.includes('참고 자료와 확인 범위'));
  assert.ok(texts.includes('검색 결과 · 본문 미확인'));
  assert.ok(texts.includes('검색 요약: <img onerror=attack()> 검색 요약'));
  assert.ok(texts.includes('PDF 텍스트 추출 · 30/72쪽 읽음'));
  assert.ok(texts.some(value => value.includes('OCR 및 CAD 형상·치수 판독은 하지 않았습니다.')));
  assert.ok(texts.some(value => value.includes('분량 제한으로 일부 내용만 읽었습니다.')));
  assert.ok(texts.some(value => value.includes('<script>source limitation</script>')));
});

test('geodata provenance shows coordinate lookup instead of document reading', async t => {
  await fixture(t);
  const article = new Element('article');
  appendProvenance(article, { sources: [{ id: 'G1', kind: 'geodata', title: '주소 조회', url: 'https://www.vworld.kr/', sha256: 'abc123', crs: 'EPSG:4326', count: 1 }] });
  const texts = [];
  const visit = node => { texts.push(node.textContent); node.children.forEach(visit); }; visit(article);
  assert.ok(texts.includes('공간정보 조회 · 좌표계 EPSG:4326 · 1건'));
  assert.ok(!texts.includes('문서 텍스트 확인'));
});

test('downloaded terrain cards show original hash, download time and unverified origin', async t => {
  await fixture(t);
  const article = new Element('article');
  appendProvenance(article, { sources: [{ id: 'G2', kind: 'geodata', title: '지형 조회', url: 'https://data.example.org/contours.geojson',
    sourceSha256: 'a'.repeat(64), downloadedAt: '2026-10-22T00:00:00Z', sourceLabel: '공개 다운로드 원본(원출처·표고 기준 미검증)', sourceKind: 'public-download' }] });
  const all = []; const visit = node => { all.push(node); node.children.forEach(visit); }; visit(article);
  assert.ok(all.some(node => node.textContent.includes('다운로드 2026-10-22T00:00:00Z')));
  assert.ok(all.some(node => node.title === `SHA256 ${'a'.repeat(64)}`));
  assert.ok(all.some(node => node.textContent.includes('원출처·표고 기준 미검증')));
});
