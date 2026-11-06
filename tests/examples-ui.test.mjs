import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createExamples, exampleFile, confirmExampleOpen } from '../public/examples.js';
import { startLocalActions } from '../public/browser-start.js';

class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: {}, hidden: true, open: false, disabled: false, textContent: '' }); }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  set innerHTML(_) { assert.fail('No HTML interpolation'); }
}

async function fixture(t) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: tag => new Element(tag) };
  t.after(() => Object.assign(globalThis, previous));
  return { ids, html };
}

test('example chooser lists Korean descriptions and sends the selected file to SiteCAD without navigation', async t => {
  const { ids } = await fixture(t);
  const selected = [], requests = [];
  const example = { file: 'retaining-wall-3m-normal.dwg', name: '옹벽 · 기본형', description: '물량 검증·기성 작업용 원본' };
  globalThis.fetch = async url => { requests.push(url); return Response.json({ ok: true, data: { examples: [example] } }); };
  createExamples({ isBusy: () => false, isReady: () => true, onOpen: async item => selected.push(item) });
  await ids['open-example'].listeners.click();
  assert.equal(ids['examples-dialog'].open, true);
  const button = ids['examples-list'].children[0];
  assert.match(button.children.map(node => node.textContent).join(' '), /옹벽.*물량/);
  await button.listeners.click();
  assert.deepEqual(selected, [example]);
  assert.equal(ids['examples-dialog'].open, false);
  assert.deepEqual(requests, ['/api/examples']);
});

test('example opening confirms unsaved or unknown drawing state and refuses unfinished CAD commands', () => {
  let prompts = 0;
  const cancel = () => { prompts++; return false; };
  assert.equal(confirmExampleOpen({ dirty: false }, cancel), true);
  assert.equal(prompts, 0);
  assert.equal(confirmExampleOpen({ dirty: true }, cancel), false);
  assert.equal(confirmExampleOpen({ document_id: 2, documents: [{ id: 2, dirty: true }] }, cancel), false);
  assert.equal(confirmExampleOpen({}, cancel), false);
  assert.equal(prompts, 3);
  assert.equal(confirmExampleOpen({ dirty: true }, () => true), true);
  for (const key of ['command', 'modal', 'text_editor', 'mtext_editor']) assert.throws(() => confirmExampleOpen({ dirty: false, [key]: {} }, cancel), /명령/);
});

test('example file downloads stay on the allowlisted local route and preserve the DWG file name', async t => {
  await fixture(t);
  const requests = [];
  globalThis.fetch = async url => { requests.push(url); return new Response('AC1032example'); };
  const file = await exampleFile({ file: 'box-culvert-2x3-normal-corrected.dwg' });
  assert.equal(file.name, 'box-culvert-2x3-normal-corrected.dwg');
  assert.equal(await file.text(), 'AC1032example');
  assert.deepEqual(requests, ['/api/examples/box-culvert-2x3-normal-corrected.dwg']);
  for (const file of ['../private.dwg', 'https://evil.test/a.dwg', 'test.exe']) await assert.rejects(exampleFile({ file }));
  assert.equal(requests.length, 1);
});

test('example load errors remain visible and busy CAD sessions cannot start an example', async t => {
  const { ids } = await fixture(t); let busy = true, calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false, error: '예제를 불러오지 못했습니다.' }, { status: 503 }); };
  createExamples({ isBusy: () => busy, isReady: () => true, onOpen: async () => assert.fail('No drawing should open') });
  await ids['open-example'].listeners.click(); assert.equal(calls, 0);
  busy = false; await ids['open-example'].listeners.click();
  assert.equal(ids['examples-dialog'].open, true);
  assert.match(ids['examples-notice'].textContent, /불러오지/);
});

test('missing and oversized example files fail before CAD receives any bytes', async t => {
  await fixture(t);
  const example = { file: 'retaining-wall-3m-normal.dwg' };
  globalThis.fetch = async () => new Response('missing', { status: 404 });
  await assert.rejects(exampleFile(example), /불러오지/);
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Length': String(31 * 1024 * 1024) }), arrayBuffer: async () => assert.fail('Do not read oversized files') });
  await assert.rejects(exampleFile(example), /용량/);
  globalThis.fetch = async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => ({ byteLength: 31 * 1024 * 1024 }) });
  await assert.rejects(exampleFile(example), /용량/);
});

test('header actions show on desktop and web, with the correct protected request and quit label', async t => {
  const { ids } = await fixture(t);
  for (const browser of [false, true]) {
    const requests = [], blocked = [];
    startLocalActions({ browser, supported: true, blocked: text => blocked.push(text), confirm: () => true,
      request: async (url, init) => { requests.push({ url, init }); return Response.json({ ok: true }); }, alert: () => assert.fail('No errors expected') });
    assert.equal(ids['local-actions'].hidden, false);
    assert.equal(ids['quit-local'].textContent, '종료');
    await ids['open-saved-folder'].listeners.click();
    await ids['quit-local'].listeners.click();
    assert.deepEqual(requests.map(item => item.url), ['open-drawings', 'quit'].map(action => `/api/${browser ? 'local' : 'desktop/local'}/${action}`));
    assert.ok(requests.every(item => item.init.method === 'POST' && item.init.body === '{}'));
    assert.equal(blocked.length, Number(browser));
  }
});

test('web quit cancellation leaves the server running and menu failures are visible', async t => {
  const { ids } = await fixture(t); let calls = 0; const errors = [];
  startLocalActions({ browser: true, supported: true, blocked: () => assert.fail('Do not terminate on cancellation'), confirm: () => false,
    request: async () => { calls++; return Response.json({ ok: false, error: '저장 폴더 접근 권한을 확인해 주세요.' }, { status: 400 }); }, alert: text => errors.push(text) });
  await ids['quit-local'].listeners.click(); assert.equal(calls, 0);
  await ids['open-saved-folder'].listeners.click(); assert.equal(calls, 1);
  assert.match(errors[0], /접근 권한/);
  ids['local-actions'].hidden = true;
  startLocalActions({ supported: false });
  assert.equal(ids['local-actions'].hidden, true);
});

test('actual browser unload handler warns during ZIP submission even when the drawing is saved', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const state of [{ browser: true, skillSharing: true }, { browser: true, skillSharing: false }, { browser: false, skillSharing: true }]) {
    let handler;
    runInNewContext(source.slice(source.lastIndexOf("addEventListener('beforeunload'")), { ...state, busy: false, unsaved: false,
      addEventListener: (name, callback) => { assert.equal(name, 'beforeunload'); handler = callback; } });
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    handler(event);
    assert.equal(prevented, state.browser && state.skillSharing);
    assert.equal(event.returnValue, prevented ? '' : undefined);
  }
});
