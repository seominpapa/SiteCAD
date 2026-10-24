import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendProvenance, createMcpSettings, safeSourceUrl } from '../public/mcp-settings.js';

const TEST_API_KEY = 'secret-key';

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

async function fixture(t, referenceState = { configured: false }, servers = [], kcsc = {}) {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [];
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: tag => new Element(tag) };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/references') ? { vworld: referenceState } : url.endsWith('/kcsc') ? kcsc : { servers } }) };
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  return { ids, requests, html };
}

const descendants = node => [node, ...node.children.flatMap(descendants)];
const content = node => descendants(node).map(item => item.textContent).join(' ');

test('source links only allow absolute HTTPS addresses without credentials', () => {
  assert.equal(safeSourceUrl('https://example.org/reference'), 'https://example.org/reference');
  for (const url of ['javascript:alert(1)', 'data:text/html,attack', 'http://example.org', '/local', 'https://user:secret@example.org']) assert.equal(safeSourceUrl(url), null);
});

test('connection dialog has an accessible registered-only list with refresh and close', async t => {
  const { html } = await fixture(t);
  const dialog = html.match(/<dialog id="mcp-dialog"[\s\S]*?<\/dialog>/)[0];
  assert.match(html, /id="manage-mcp"[^>]*>외부 연결<\/button>/);
  assert.match(dialog, /aria-labelledby="mcp-dialog-title"/);
  assert.match(dialog, /id="mcp-dialog-title">외부 연결<\/h2>/);
  assert.match(dialog, /aria-label="외부 연결 닫기"/);
  assert.match(dialog, /id="mcp-server-list"[^>]*aria-live="polite"/);
  assert.equal((dialog.match(/<button/g) || []).length, 2);
  assert.doesNotMatch(dialog, /<input|<textarea|reference-catalog|mcp-config|REA|KDS|지형 원본/);
});

test('empty connections show no presets or unconfigured APIs and guide registration through chat', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false, notify: assert.fail });
  settings.update({ desktop: true });
  await settings.refresh();
  assert.match(content(ids['mcp-server-list']), /등록된 연결이 없습니다.*채팅/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /REA|VWorld|OpenCAD|KDS/);
  assert.equal(ids['external-mcp-status'].textContent, '등록된 연결 없음');
  assert.equal(ids['mcp-dialog'].open, false);
  assert.equal(settings.handleCommand, undefined);
  assert.deepEqual(requests.map(item => item.url).sort(), ['/api/desktop/kcsc', '/api/desktop/mcp', '/api/desktop/plugins', '/api/desktop/references']);
  assert.ok(requests.every(item => !item.method || item.method === 'GET'));
});

test('registered MCPs including REA are read-only and expose status without commands or secrets', async t => {
  const servers = [
    { name: 'rea', enabled: true, connected: true, transport: 'stdio', tools: ['inspect'], command: '/private/secret', args: ['credential'], envKeys: ['TOKEN'] },
    { name: '<img onerror=attack()>', enabled: false, connected: true },
    { name: 'oauth', enabled: true, status: 'authenticationRequired' },
    { name: 'failed', enabled: true, status: 'failed', error: 'secret backend path' },
    { name: 'waiting', enabled: true },
  ];
  const { ids } = await fixture(t, { configured: false }, servers);
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true }); await settings.refresh();
  const cards = ids['mcp-server-list'].children;
  assert.equal(cards.length, 5);
  for (const [index, status] of ['연결됨', '사용 안 함', '인증 필요', '연결 실패', '연결 확인 필요'].entries()) assert.equal(cards[index].children[0].children[1].textContent, status);
  assert.match(content(cards[0]), /rea.*MCP.*stdio.*도구 1개/);
  assert.match(content(cards[1]), /<img onerror=attack\(\)>/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /private|credential|TOKEN|secret backend/);
  assert.equal(descendants(ids['mcp-server-list']).filter(item => ['button', 'input', 'textarea'].includes(item.tagName)).length, 0);
  assert.equal(ids['external-mcp-status'].textContent, 'MCP 5 · API 0 · 플러그인 0');
});

test('KCSC is one registered MCP row with private-key status and chat registration guidance', async t => {
  const { ids, html } = await fixture(t, { configured: false }, [{ name: 'kcsc', enabled: true, connected: true, transport: 'stdio', tools: ['search'] }], { configured: false, connected: false });
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true }); await settings.refresh();
  assert.equal(ids['mcp-server-list'].children.length, 1);
  assert.match(content(ids['mcp-server-list']), /KCSC.*키 미등록.*MCP.*\/api kcsc/);
  assert.equal(ids['external-mcp-status'].textContent, 'MCP 1 · API 0 · 플러그인 0');
  settings.update({ desktop: true, kcsc: { configured: true, connected: true, count: 7, lastCheck: { ok: true } } });
  assert.match(content(ids['mcp-server-list']), /키 등록됨.*연결 확인됨/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /키 미등록/);
  settings.update({ desktop: true, kcsc: { configured: true, connected: false, lastCheck: { ok: false }, apiKey: TEST_API_KEY, path: '/private/user' } });
  assert.match(content(ids['mcp-server-list']), /연결 확인 실패/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /secret-key|private\/user|연결 확인됨/);
  settings.update({ desktop: true, externalMcp: { servers: [] } });
  assert.doesNotMatch(content(ids['mcp-server-list']), /KCSC/);
  assert.match(html, /data-prompt="\/api kcsc"/);
});

test('only a configured VWorld API is listed and unverified credentials are not called connected', async t => {
  const { ids } = await fixture(t, { configured: true, domain: 'private.example', apiKey: 'secret-key' });
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true }); await settings.refresh();
  assert.match(content(ids['mcp-server-list']), /VWorld.*등록됨 · 연결 미확인.*API/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /private.example|secret-key|연결됨/);
  assert.equal(ids['external-mcp-status'].textContent, 'MCP 0 · API 1 · 플러그인 0');
  settings.update({ desktop: true });
  assert.match(content(ids['mcp-server-list']), /VWorld/);
  settings.update({ desktop: true, references: { vworld: { configured: true, lastCheck: { ok: true } } } });
  assert.match(content(ids['mcp-server-list']), /연결 확인됨/);
  settings.update({ desktop: true, references: { vworld: { configured: true, lastCheck: { ok: false } } } });
  assert.match(content(ids['mcp-server-list']), /연결 확인 실패/);
  settings.update({ desktop: true, references: { vworld: { configured: false } } });
  assert.doesNotMatch(content(ids['mcp-server-list']), /VWorld/);
});

test('a preconfigured API connector without its key shows registration guidance in the inventory', async t => {
  const { ids } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true, references: { catalog: [{ id: 'vworld', kind: 'api' }], vworld: { configured: false } } });
  assert.match(content(ids['mcp-server-list']), /VWorld.*키 미등록.*\/api vworld/);
  assert.equal(ids['external-mcp-status'].textContent, 'MCP 0 · API 1 · 플러그인 0');
  settings.update({ desktop: true, references: { vworld: { configured: true } } });
  assert.match(content(ids['mcp-server-list']), /키 등록됨/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /키 미등록/);
});

test('installed plugins appear separately without source code, private paths or install actions', async t => {
  const { ids, html } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true, plugins: [
    { name: 'quantity-workflows', version: '1.0.0', skills: ['plugin-quantity-check'], status: 'installed', path: '/private/path', body: 'untrusted source' },
    { name: 'changed', skills: [], status: 'modified' },
    { name: 'missing', status: 'unavailable' },
  ] });
  assert.match(content(ids['mcp-server-list']), /quantity-workflows.*설치됨.*플러그인.*1.0.0.*스킬 1개/);
  assert.match(content(ids['mcp-server-list']), /수정됨.*확인 필요/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /private\/path|untrusted source|연결됨/);
  assert.equal(ids['external-mcp-status'].textContent, 'MCP 0 · API 0 · 플러그인 3');
  assert.match(html, /data-prompt="API 등록해줘"[^>]*>API 등록/);
  assert.match(html, /플러그인 설치 안내/);
});

test('opening and refreshing reads current connections without registration or test requests', async t => {
  const { ids, requests } = await fixture(t, { configured: false }, [{ name: 'fresh', enabled: true, connected: true }]);
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true });
  await ids['manage-mcp'].listeners.click();
  assert.equal(ids['mcp-dialog'].open, true);
  assert.match(content(ids['mcp-server-list']), /fresh/);
  await ids['mcp-refresh'].listeners.click();
  assert.equal(requests.length, 8);
  assert.ok(requests.every(item => ['/api/desktop/mcp', '/api/desktop/references', '/api/desktop/plugins', '/api/desktop/kcsc'].includes(item.url) && !item.body));
});

test('failed refresh remains visible and retains the previous complete inventory', async t => {
  const { ids } = await fixture(t, { configured: true }, [{ name: 'kept', enabled: true }]);
  const settings = createMcpSettings({ isBusy: () => false });
  settings.update({ desktop: true }); await settings.refresh();
  globalThis.fetch = async url => ({ ok: !url.endsWith('/references'), json: async () => url.endsWith('/references') ? { ok: false, error: '상태 조회 실패' } : { ok: true, data: { servers: [{ name: 'partial-new' }] } } });
  await ids['mcp-refresh'].listeners.click();
  assert.equal(ids['mcp-notice'].hidden, false);
  assert.match(ids['mcp-notice'].textContent, /상태 조회 실패/);
  assert.match(content(ids['mcp-server-list']), /kept.*VWorld/);
  assert.doesNotMatch(content(ids['mcp-server-list']), /partial-new/);
  assert.equal(ids['mcp-refresh'].disabled, false);
});

test('busy or unsupported state blocks inventory actions while close remains available', async t => {
  const { ids, requests, html } = await fixture(t);
  let busy = true;
  const settings = createMcpSettings({ isBusy: () => busy });
  settings.update({ desktop: true });
  assert.equal(ids['manage-mcp'].disabled, true);
  assert.equal(ids['mcp-refresh'].disabled, true);
  await ids['manage-mcp'].listeners.click(); await ids['mcp-refresh'].listeners.click();
  assert.equal(requests.length, 0);
  assert.equal(ids['mcp-dialog'].open, false);
  assert.match(html, /<button type="submit" aria-label="외부 연결 닫기">/);
  busy = false; settings.sync();
  assert.equal(ids['mcp-refresh'].disabled, false);
  settings.update({ desktop: false });
  assert.equal(ids['manage-mcp'].hidden, true);
  assert.equal(ids['external-mcp-status'].hidden, true);
  await settings.refresh();
  assert.equal(requests.length, 0);
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

test('plugin approval shows all instructions and rejects content exceeding the review limit', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true });
  const instructions = '사용자가 지정한 도면만 조회합니다.\n'.repeat(1000);
  settings.update({ desktop: true, approvals: [{ id: 'plugin', kind: 'plugin-install', server: 'sitecad', tool: 'install', arguments: instructions }] });
  let card = ids['tool-approvals'].children.at(-1);
  assert.equal(card.children[0].textContent, '플러그인 변경 승인');
  assert.equal(card.children[2].textContent, instructions);
  assert.match(card.children[3].textContent, /슬래시 명령.*도면 저장 검증/);
  await card.children.at(-1).children[0].listeners.click();
  assert.deepEqual(JSON.parse(requests[0].body), { id: 'plugin', approved: true });
  settings.update({ desktop: true, approvals: [{ id: 'large', kind: 'plugin-remove', arguments: 'x'.repeat(512 * 1024 + 1) }] });
  card = ids['tool-approvals'].children.at(-1);
  assert.equal(card.children.at(-1).children[0].disabled, true);
  await card.children.at(-1).children[0].listeners.click();
  assert.equal(requests.length, 1);
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

test('persistent MCP installation and skill replacement approvals explain their scope', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true, notify: assert.fail });
  settings.update({ desktop: true, approvals: [{ id: 'install', kind: 'mcp-install', server: 'SiteCAD', tool: 'MCP 설치 및 연결', arguments: { package: '@example/mcp@1.0.0' } }] });
  const install = ids['tool-approvals'].children[0];
  assert.match(install.children[0].textContent, /설치·연결/);
  assert.match(install.children[3].textContent, /사용자 권한.*파일/);
  assert.match(install.children[3].textContent, /SiteCAD.*설정/);
  assert.doesNotMatch(install.children[3].textContent, /한 번 실행/);
  assert.equal(install.children.at(-1).children[0].textContent, '설치·연결 승인');
  await install.children.at(-1).children[0].listeners.click();
  assert.deepEqual(JSON.parse(requests[0].body), { id: 'install', approved: true });
  settings.update({ desktop: true, approvals: [{ id: 'overwrite', kind: 'skill-overwrite', server: 'SiteCAD', tool: '스킬 수정', arguments: { name: 'quantity-review' } }] });
  const overwrite = ids['tool-approvals'].children[0];
  assert.match(overwrite.children[0].textContent, /스킬 덮어쓰기/);
  assert.match(overwrite.children[3].textContent, /기존 스킬.*교체/);
  assert.equal(overwrite.children.at(-1).children[0].textContent, '덮어쓰기 승인');
});

test('large skill overwrite reviews show the whole bounded skill and remain approvable', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true, notify: assert.fail });
  const args = { name: 'large-review', description: '큰 스킬의 검토', body: `${'\t'.repeat(60000)}끝까지 확인`, expectedHash: 'a'.repeat(64) };
  const argumentText = JSON.stringify(args, null, 2);
  assert.ok(argumentText.length > 70000);
  settings.update({ desktop: true, approvals: [{ id: 'large-skill', kind: 'skill-overwrite', server: 'SiteCAD', tool: '스킬 수정', arguments: args }] });
  const card = ids['tool-approvals'].children[0];
  assert.ok(card.children[2].textContent === argumentText, 'The full skill review must remain visible.');
  assert.match(card.children[2].textContent, /끝까지 확인/);
  assert.doesNotMatch(card.children[3].textContent, /앞 .*자만|전체 입력을 확인할 수 없/);
  assert.equal(card.children.at(-1).children[0].disabled, false);
  await card.children.at(-1).children[0].listeners.click();
  assert.deepEqual(JSON.parse(requests[0].body), { id: 'large-skill', approved: true });
});


test('oversized skill reviews stay bounded and cannot approve hidden content', async t => {
  const { ids, requests } = await fixture(t);
  const settings = createMcpSettings({ isBusy: () => true, notify: assert.fail });
  settings.update({ desktop: true, approvals: [{ id: 'oversized-skill', kind: 'skill-overwrite', server: 'SiteCAD', tool: '스킬 수정', arguments: { body: 'x'.repeat(600000) } }] });
  const card = ids['tool-approvals'].children[0];
  assert.equal(card.children[2].textContent.length, 512 * 1024);
  assert.match(card.children[3].textContent, /전체 입력을 확인할 수 없/);
  assert.equal(card.children.at(-1).children[0].disabled, true);
  await card.children.at(-1).children[0].listeners.click();
  assert.equal(requests.length, 0);
});
