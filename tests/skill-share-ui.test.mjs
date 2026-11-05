import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSkillShare } from '../public/skill-share.js';

const background = { situation: '도면 물량 검토', problem: '직경 연결 누락', changeReason: '범례와 지시선부터 조회', examplePrompt: '물량 검증해줘', expectedResult: '검증된 직경별 표' };
class Element {
  constructor() { Object.assign(this, { value: '', textContent: '', hidden: false, disabled: false, listeners: {} }); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
}
async function fixture(t, { fail = false } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const downloads = [], calls = [], pending = [];
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: () => { const anchor = new Element(); downloads.push(anchor); return anchor; }, body: { append() {} } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('export-context')) return { ok: true, json: async () => ({ ok: true, data: { background } }) };
    return fail ? { ok: false, json: async () => ({ error: '스킬 폴더를 확인해 주세요.' }) } : { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="SiteCAD-skills-0.16.4.zip"' }), blob: async () => new Blob(['ZIP']) };
  };
  t.after(() => Object.assign(globalThis, previous));
  let busy = false;
  let chatId = 'e14c38dc-4d6b-4a4e-8aae-626094d0e95a';
  const api = createSkillShare({ isBusy: () => busy, onPending: value => pending.push(value), getChatId: () => chatId });
  return { api, ids, downloads, calls, pending, html, setBusy(value) { busy = value; }, setChatId(value) { chatId = value; } };
}

test('skill share previews automatically generated context without questions and downloads using the same chat id', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  for (const [key, value] of Object.entries(background)) assert.equal(f.ids[`skill-share-${key}`].textContent, value);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { chatId: 'e14c38dc-4d6b-4a4e-8aae-626094d0e95a' });
  const dialog = f.html.slice(f.html.indexOf('<dialog id="skill-share-dialog"'), f.html.indexOf('<dialog id="settings-dialog"'));
  assert.doesNotMatch(dialog, /<textarea|<input|<label|required|어떤.*\?|무엇.*\?/);
  assert.match(dialog, /자동/);
  assert.match(dialog, /<dl/);
  f.setChatId('92fae59c-a659-43ac-988f-06365ad074e9');
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(f.calls[1].init.body), JSON.parse(f.calls[0].init.body));
  assert.equal(f.calls[1].init.method, 'POST');
  assert.equal(f.downloads[0].download, 'SiteCAD-skills-0.16.4.zip');
  assert.equal(f.downloads[0].clicked, true);
  assert.equal(f.ids['skill-share-email'].hidden, false);
  assert.match(f.ids['skill-share-notice'].textContent, /添付|첨부/);
  assert.match(f.ids['skill-share-email'].href, /^mailto:seominpapa@gmail.com\?/);
  assert.deepEqual(f.pending, [true, false]);
});

test('failed exports cannot claim success or open mail and generated preview renders as literal bounded text', async t => {
  const f = await fixture(t, { fail: true });
  f.api.update({ desktop: true });
  const requests = globalThis.fetch;
  globalThis.fetch = (url, init) => url.endsWith('export-context') ? Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { background: { ...background, problem: '<script>private</script>'.repeat(300) } } }) }) : requests(url, init);
  await f.ids['skill-share-open'].listeners.click();
  assert.ok(f.ids['skill-share-problem'].textContent.startsWith('<script>private</script>'));
  assert.equal(f.ids['skill-share-problem'].textContent.length, 4000);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.downloads.length, 0);
  assert.equal(f.ids['skill-share-email'].hidden, true);
  assert.match(f.ids['skill-share-notice'].textContent, /확인/);
  f.api.update({ desktop: false });
  assert.equal(f.ids['skill-share-open'].hidden, true);
  assert.match(f.html, /스킬 폴더 전체/);
});

test('late context responses cannot replace a newer preview and download waits for generation', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const opening = f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-download'].disabled, true);
  f.ids['skill-share-close'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, false);
  f.ids['skill-share-problem'].textContent = '새로 열린 미리보기';
  release({ ok: true, json: async () => ({ ok: true, data: { background } }) });
  await opening;
  assert.equal(f.ids['skill-share-problem'].textContent, '새로 열린 미리보기');
  assert.equal(f.ids['skill-share-download'].disabled, true);
});

test('reopening automatically regenerates context and ignores an earlier response', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  const releases = [];
  globalThis.fetch = () => new Promise(resolve => releases.push(resolve));
  const first = f.ids['skill-share-open'].listeners.click();
  f.ids['skill-share-close'].listeners.click();
  const second = f.ids['skill-share-open'].listeners.click();
  releases[1]({ ok: true, json: async () => ({ ok: true, data: { background: { ...background, problem: '최신 대화의 문제' } } }) });
  await second;
  assert.equal(f.ids['skill-share-problem'].textContent, '최신 대화의 문제');
  releases[0]({ ok: true, json: async () => ({ ok: true, data: { background } }) });
  await first;
  assert.equal(f.ids['skill-share-problem'].textContent, '최신 대화의 문제');
  assert.equal(f.ids['skill-share-download'].disabled, false);
});

test('busy work blocks opening and pending ZIP generation blocks closing or repeated submit', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  f.setBusy(true);
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.calls.length, 0);
  f.setBusy(false);
  await f.ids['skill-share-open'].listeners.click();
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const exporting = f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  f.ids['skill-share-close'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  let prevented = false;
  f.ids['skill-share-dialog'].listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  release({ ok: true, headers: new Headers() });
  await exporting;
  assert.match(f.ids['skill-share-notice'].textContent, /다운로드 이름/);
  f.ids['skill-share-dialog'].listeners.cancel({ preventDefault() { assert.fail(); } });
  assert.equal(f.ids['skill-share-close'].disabled, false);
});

test('missing context asks to retry generation and cannot request manual input or download stale data', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  globalThis.fetch = async () => { throw Error('/private/credential-path'); };
  await f.ids['skill-share-open'].listeners.click();
  assert.match(f.ids['skill-share-notice'].textContent, /다시/);
  assert.doesNotMatch(f.ids['skill-share-notice'].textContent, /직접 입력|작성해|입력해/);
  assert.doesNotMatch(f.ids['skill-share-notice'].textContent, /private/);
  assert.equal(f.ids['skill-share-download'].disabled, true);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.downloads.length, 0);
  f.ids['skill-share-close'].listeners.click();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { background } }) });
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-download'].disabled, false);
});

test('preview can use all skills when no current chat exists and rejects incomplete generated output', async t => {
  const f = await fixture(t);
  const api = createSkillShare({ isBusy: () => false });
  api.update({ desktop: true });
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, data: { background: {} } }) };
  };
  await f.ids['skill-share-open'].listeners.click();
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
  assert.equal(f.ids['skill-share-download'].disabled, true);
  assert.match(f.ids['skill-share-notice'].textContent, /다시/);
});

test('oversized downloads are rejected before saving or showing the mail link', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  const headers = { 'Content-Disposition': 'attachment; filename="SiteCAD-skills-0.16.4.zip"' };
  let requestedBlob = false;
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ ...headers, 'Content-Length': String(19 * 1024 * 1024) }), blob: async () => { requestedBlob = true; return new Blob(['zip']); } });
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(requestedBlob, false);
  assert.match(f.ids['skill-share-notice'].textContent, /용량/);
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(headers), blob: async () => ({ size: 19 * 1024 * 1024 }) });
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.downloads.length, 0);
  assert.equal(f.ids['skill-share-email'].hidden, true);
  assert.match(f.ids['skill-share-notice'].textContent, /용량/);
});
