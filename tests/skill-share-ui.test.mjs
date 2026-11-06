import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSkillShare } from '../public/skill-share.js';

const TEST_VERIFICATION_TOKEN = 'verified-token';

class Element {
  constructor() { Object.assign(this, { textContent: '', hidden: false, disabled: false, open: false, listeners: {} }); }
  set innerHTML(_) { throw Error('Untrusted HTML must not render.'); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
}
async function fixture(t, { fail = false, withoutChat = false, submitEnabled = false } = {}) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^\"]+)"/g)].map(([, id]) => [id, new Element()]));
  const downloads = [], calls = [], pending = [], windowEvents = {};
  globalThis.window = { location: { origin: 'http://127.0.0.1:1234' }, addEventListener(name, fn) { windowEvents[name] = fn; } };
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: () => { const anchor = new Element(); downloads.push(anchor); return anchor; }, body: { append() {} } };
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/submission-config')) return { ok: true, json: async () => ({ ok: true, data: { enabled: submitEnabled, origin: 'https://submit.test', challengeUrl: 'https://submit.test/challenge' } }) };
    calls.push({ url, init });
    return fail ? { ok: false, json: async () => ({ error: '스킬 폴더를 확인해 주세요.' }) } : { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="SiteCAD-skills-0.16.4.zip"' }), blob: async () => new Blob(['ZIP']) };
  };
  t.after(() => Object.assign(globalThis, previous));
  let busy = false;
  let chatId = 'e14c38dc-4d6b-4a4e-8aae-626094d0e95a';
  const api = createSkillShare({ isBusy: () => busy, onPending: value => pending.push(value), ...(!withoutChat && { getChatId: () => chatId }) });
  ids['skill-share-verification'].contentWindow = {};
  return { api, ids, downloads, calls, pending, html, windowEvents, setBusy(value) { busy = value; }, setChatId(value) { chatId = value; } };
}

test('opening needs no explanation input; saving captures the chat and offers fixed email guidance', async t => {
  const f = await fixture(t);
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  assert.equal(f.calls.length, 0);
  const dialog = f.html.slice(f.html.indexOf('<dialog id="skill-share-dialog"'), f.html.indexOf('<dialog id="settings-dialog"'));
  assert.doesNotMatch(dialog, /<textarea|<dl|<dd|skill-share-(?:situation|problem|changeReason|examplePrompt|expectedResult)|미리보기/);
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

test('submission requires public consent and verification from exact iframe origin, window and nonce', async t => {
  const f = await fixture(t, { submitEnabled: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  const frame = f.ids['skill-share-verification'];
  const nonce = new URL(frame.src).searchParams.get('nonce');
  assert.equal(new URL(frame.src).searchParams.get('origin'), 'http://127.0.0.1:1234');
  const valid = { origin: 'https://submit.test', source: frame.contentWindow, data: { type: 'sitecad-skill-verification', nonce, token: TEST_VERIFICATION_TOKEN } };
  f.ids['skill-share-consent'].checked = true;
  for (const bad of [{ ...valid, origin: 'https://evil.test' }, { ...valid, source: {} }, { ...valid, data: { ...valid.data, nonce: 'wrong' } }, { ...valid, data: { ...valid.data, token: 'x'.repeat(2049) } }]) f.windowEvents.message(bad);
  f.ids['skill-share-consent'].listeners.change();
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  f.windowEvents.message(valid);
  assert.equal(f.ids['skill-share-submit'].disabled, false);
  f.windowEvents.message({ ...valid, data: { ...valid.data, token: '' } });
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  f.windowEvents.message(valid);
  f.ids['skill-share-consent'].checked = false;
  f.ids['skill-share-consent'].listeners.change();
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  f.ids['skill-share-consent'].checked = true;
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, init });
    const input = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true, data: { submissionId: input.submissionId, state: 'submitted', issueUrl: 'https://github.com/seominpapa/SiteCAD/issues/23' } }) };
  };
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/desktop/skills/submit');
  assert.equal(JSON.parse(f.calls[0].init.body).consent, true);
  assert.equal(f.ids['skill-share-result'].href, 'https://github.com/seominpapa/SiteCAD/issues/23');
  assert.equal(f.ids['skill-share-result'].hidden, false);
  assert.equal(f.ids['skill-share-submit'].disabled, true);
});

test('failed, expired and stalled verification explain recovery without enabling submission', async t => {
  const previous = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let waiting, cleared = false;
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 30000); waiting = callback; return { unref() {} }; };
  globalThis.clearTimeout = () => { cleared = true; };
  t.after(() => Object.assign(globalThis, previous));
  const f = await fixture(t, { submitEnabled: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  assert.equal(typeof waiting, 'function');
  waiting();
  assert.match(f.ids['skill-share-notice'].textContent, /보안 확인.*닫았다가/);
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  const frame = f.ids['skill-share-verification'];
  const event = reason => ({ origin: 'https://submit.test', source: frame.contentWindow, data: { type: 'sitecad-skill-verification', nonce: new URL(frame.src).searchParams.get('nonce'), token: '', reason } });
  f.windowEvents.message(event('failed'));
  assert.match(f.ids['skill-share-notice'].textContent, /실패/);
  assert.equal(cleared, true);
  f.windowEvents.message(event('expired'));
  assert.match(f.ids['skill-share-notice'].textContent, /만료/);
  f.ids['skill-share-consent'].checked = true;
  f.ids['skill-share-consent'].listeners.change();
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  f.windowEvents.message({ ...event('failed'), origin: 'https://evil.test' });
  assert.match(f.ids['skill-share-notice'].textContent, /만료/);
  f.ids['skill-share-close'].listeners.click();
  const before = f.ids['skill-share-notice'].textContent;
  waiting();
  assert.equal(f.ids['skill-share-notice'].textContent, before);
});

test('active submission prevents closing and duplicate requests until actual response', async t => {
  const f = await fixture(t, { submitEnabled: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  const frame = f.ids['skill-share-verification'];
  f.ids['skill-share-consent'].checked = true;
  f.windowEvents.message({ origin: 'https://submit.test', source: frame.contentWindow, data: { type: 'sitecad-skill-verification', nonce: new URL(frame.src).searchParams.get('nonce'), token: TEST_VERIFICATION_TOKEN } });
  let release, requests = 0;
  globalThis.fetch = async (url, init) => { requests++; const body = JSON.parse(init.body); return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, data: { submissionId: body.submissionId, state: 'pending' } }) }); }); };
  const operation = f.ids['skill-share-submit'].listeners.click();
  f.ids['skill-share-close'].listeners.click();
  assert.equal(f.ids['skill-share-dialog'].open, true);
  assert.equal(f.ids['skill-share-result'].hidden, true);
  let prevented = false;
  f.ids['skill-share-dialog'].listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(requests, 1);
  release();
  await operation;
  assert.deepEqual(f.pending, [true, false]);
});

test('pending or failed submissions preserve ID, require fresh verification, and never claim submitted', async t => {
  const f = await fixture(t, { submitEnabled: true });
  f.api.update({ desktop: true });
  await f.ids['skill-share-open'].listeners.click();
  f.ids['skill-share-consent'].checked = true;
  const verified = () => {
    const frame = f.ids['skill-share-verification'];
    f.windowEvents.message({ origin: 'https://submit.test', source: frame.contentWindow, data: { type: 'sitecad-skill-verification', nonce: new URL(frame.src).searchParams.get('nonce'), token: 'fresh-token' } });
  };
  const attempts = [];
  globalThis.fetch = async (url, init) => { const input = JSON.parse(init.body); attempts.push(input); return { ok: true, json: async () => ({ ok: true, data: { submissionId: input.submissionId, state: 'pending' } }) }; };
  verified();
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(f.ids['skill-share-result'].hidden, true);
  assert.match(f.ids['skill-share-notice'].textContent, /확인|처리/);
  assert.equal(f.ids['skill-share-submit'].disabled, true);
  verified();
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(attempts[0].submissionId, attempts[1].submissionId);
  globalThis.fetch = async (url, init) => { attempts.push(JSON.parse(init.body)); return { ok: false, json: async () => ({ error: '제출 서버를 확인해 주세요.' }) }; };
  verified();
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(attempts[0].submissionId, attempts[2].submissionId);
  assert.equal(f.ids['skill-share-result'].hidden, true);
  assert.equal(f.ids['skill-share-close'].disabled, false);
  f.ids['skill-share-close'].listeners.click();
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/submission-config')) return { ok: true, json: async () => ({ ok: true, data: { enabled: true, origin: 'https://submit.test', challengeUrl: 'https://submit.test/challenge' } }) };
    attempts.push(JSON.parse(init.body)); return { ok: false, json: async () => ({ error: '제출 서버를 확인해 주세요.' }) };
  };
  f.setChatId('92fae59c-a659-43ac-988f-06365ad074e9');
  await f.ids['skill-share-open'].listeners.click();
  f.ids['skill-share-consent'].checked = true;
  verified();
  await f.ids['skill-share-submit'].listeners.click();
  assert.equal(attempts[0].submissionId, attempts[3].submissionId);
  assert.equal(attempts[0].chatId, attempts[3].chatId);
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
