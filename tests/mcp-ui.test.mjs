import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendProvenance, createMcpSettings, safeSourceUrl } from '../public/mcp-settings.js';

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

test('source links only allow absolute HTTPS addresses without credentials', () => {
  assert.equal(safeSourceUrl('https://example.org/reference'), 'https://example.org/reference');
  for (const url of ['javascript:alert(1)', 'data:text/html,attack', 'http://example.org', '/local', 'https://user:secret@example.org']) assert.equal(safeSourceUrl(url), null);
});

test('external connections are consolidated into the accessible settings tabs',async t=>{
  const {html}=await fixture(t);
  assert.doesNotMatch(html,/id="(?:mcp-dialog|manage-mcp|external-mcp-status)"/);
  assert.match(html,/id="settings-dialog"[^>]*aria-labelledby="settings-title"/);
  for(const tab of ['api','mcp','plugins'])assert.match(html,new RegExp(`id="settings-tab-${tab}"[^>]*role="tab"`));
});

test('approval helper does not duplicate settings inventories or read credentials',async t=>{
  const {ids,requests}=await fixture(t);
  const settings=createMcpSettings({isBusy:()=>false,notify:assert.fail});
  settings.update({desktop:true,externalMcp:{servers:[{name:'demo'}]},references:{vworld:{configured:true}}});
  settings.sync();await settings.refresh();
  assert.equal(requests.length,0);assert.equal(ids['tool-approvals'].hidden,true);
  assert.equal(settings.handleCommand,undefined);
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

test('persistent MCP installation, API registration and skill replacement approvals explain their scope', async t => {
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
  settings.update({ desktop:true,approvals:[{id:'api',kind:'api-register',server:'SiteCAD',tool:'API 항목 등록',arguments:{name:'공식 API',url:'https://example.org/docs'}}] });
  const api=ids['tool-approvals'].children[0];
  assert.equal(api.children[0].textContent,'API 항목 등록 승인');
  assert.match(api.children[3].textContent,/설정 → API.*보관/);
  assert.match(api.children[3].textContent,/실제 API 호출.*아닙니다/);
  assert.equal(api.children.at(-1).children[0].textContent,'API 항목 등록 승인');
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
