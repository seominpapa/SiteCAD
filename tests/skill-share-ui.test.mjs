import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSkillShare } from '../public/skill-share.js';

class Element {
  constructor() { Object.assign(this, { textContent: '', hidden: false, disabled: false, open: false, listeners: {} }); }
  set innerHTML(_) { throw Error('Untrusted HTML must not render.'); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
}
async function fixture(t, { fail = false, withoutChat = false } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^\"]+)"/g)].map(([, id]) => [id, new Element()]));
  const downloads = [], calls = [], pending = [];
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: () => { const anchor = new Element(); downloads.push(anchor); return anchor; }, body: { append() {} } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return fail ? { ok: false, json: async () => ({ error: '스킬 폴더를 확인해 주세요.' }) } : { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="SiteCAD-skills-0.16.4.zip"' }), blob: async () => new Blob(['ZIP']) };
  };
  t.after(() => Object.assign(globalThis, previous));
  let busy = false;
  let chatId = 'e14c38dc-4d6b-4a4e-8aae-626094d0e95a';
  const api = createSkillShare({ isBusy: () => busy, onPending: value => pending.push(value), ...(!withoutChat && { getChatId: () => chatId }) });
  return { api, ids, downloads, calls, pending, html, setBusy(value) { busy = value; }, setChatId(value) { chatId = value; } };
}

test('opening needs no context request, preview or input; saving captures the chat and offers fixed email guidance', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  assert.equal(f.calls.length, 0);
  const dialog = f.html.slice(f.html.indexOf('<dialog id="skill-share-dialog"'), f.html.indexOf('<dialog id="settings-dialog"'));
  assert.doesNotMatch(dialog, /<textarea|<input|<label|<dl|<dd|skill-share-(?:situation|problem|changeReason|examplePrompt|expectedResult)|미리보기/);
  assert.match(dialog, /자동/);
  assert.match(dialog, /seominpapa@gmail\.com/);
  assert.match(dialog, /직접 첨부/);
  f.setChatId('92fae59c-a659-43ac-988f-06365ad074e9');
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/desktop/skills/export');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { chatId: 'e14c38dc-4d6b-4a4e-8aae-626094d0e95a' });
  assert.equal(f.downloads[0].download, 'SiteCAD-skills-0.16.4.zip');
  assert.equal(f.downloads[0].clicked, true);
  assert.match(f.ids['skill-share-notice'].textContent, /저장/);
  assert.match(f.ids['skill-share-notice'].textContent, /첨부/);
  assert.deepEqual(f.pending, [true, false]);
});

test('an export without a current chat uses only empty input and never asks for report text', async t => {
  const f = await fixture(t, { withoutChat: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {});
  assert.doesNotMatch(f.ids['skill-share-notice'].textContent, /입력해|작성해/);
});

test('failed exports leave the dialog ready to retry without claiming a saved file', async t => {
  const f = await fixture(t, { fail: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.downloads.length, 0);
  assert.match(f.ids['skill-share-notice'].textContent, /확인/);
  assert.equal(f.ids['skill-share-download'].disabled, false);
  f.api.update({ desktop: false });
  assert.equal(f.ids['skill-share-open'].hidden, true);
});

test('busy work blocks opening; pending ZIP creation blocks closing or duplicate submit', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  f.setBusy(true);
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, false);
  f.setBusy(false);
  await f.ids['skill-share-open'].listeners.click();
  let release;
  let requests = 0;
  globalThis.fetch = () => { requests++; return new Promise(resolve => { release = resolve; }); };
  const exporting = f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  f.ids['skill-share-close'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  let prevented = false;
  f.ids['skill-share-dialog'].listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(requests, 1);
  release({ ok: true, headers: new Headers() });
  await exporting;
  assert.match(f.ids['skill-share-notice'].textContent, /다운로드 이름/);
  f.ids['skill-share-dialog'].listeners.cancel({ preventDefault() { assert.fail(); } });
  f.ids['skill-share-close'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, false);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.equal(requests, 1);
});

test('reopening captures the new active chat without any preview fetch', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  f.ids['skill-share-close'].listeners.click();
  const next = '92fae59c-a659-43ac-988f-06365ad074e9';
  f.setChatId(next);
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.calls.length, 0);
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { chatId: next });
});

test('oversized downloads and unsafe attachment names are rejected without saving', async t => {
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
  assert.match(f.ids['skill-share-notice'].textContent, /용량/);
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="../../credentials.zip"' }) });
  await f.ids['skill-share-form'].listeners.submit({ preventDefault() {} });
  assert.match(f.ids['skill-share-notice'].textContent, /다운로드 이름/);
  assert.equal(f.downloads.length, 0);
});
