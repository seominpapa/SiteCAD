import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSkillMenu } from '../public/skills.js';

class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: {}, value: '', hidden: false, disabled: false, textContent: '' }); }
  set innerHTML(_) { throw Error('Untrusted HTML must never render.'); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const before = { document: globalThis.document, fetch: globalThis.fetch };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [];
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: tag => new Element(tag) };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, data: { skills: [
      { name: 'skill-creator', description: '<img onerror=attack()> 스킬 만들기', builtin: true, path: '/private/hidden' },
      { name: 'layer-review', description: '레이어 물량검토' },
      { name: '../../unsafe', description: 'unsafe' },
    ] } }) };
  };
  t.after(() => { globalThis.document = before.document; globalThis.fetch = before.fetch; });
  return { ids, requests };
}

test('installed skills are listed safely and a selected slash remains chat input', async t => {
  const { ids, requests } = await fixture(t);
  let changes = 0;
  const menu = createSkillMenu({ isBusy: () => false, onChange: () => { changes++; } });
  menu.update({ desktop: false });
  assert.equal(requests.length, 0);
  assert.equal(ids['skill-toggle'].hidden, true);
  menu.update({ desktop: true }); await flush();
  assert.equal(requests[0].url, '/api/desktop/skills');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(ids['skill-list'].children.length, 2);
  assert.match(ids['skill-list'].children[0].children[1].textContent, /<img onerror=attack\(\)>/);
  assert.doesNotMatch(JSON.stringify(ids['skill-list']), /private\/hidden/);
  ids['skill-toggle'].listeners.click();
  assert.equal(ids['skill-menu'].hidden, false);
  ids['skill-list'].children[1].listeners.click();
  assert.equal(ids['message-input'].value, '/layer-review ');
  assert.equal(ids['message-input'].focused, true);
  assert.equal(ids['skill-menu'].hidden, true);
  assert.equal(changes, 1);
  assert.equal(requests.length, 1);
});

test('slash suggestions filter installed names without executing or fetching per keystroke', async t => {
  const { ids, requests } = await fixture(t);
  const menu = createSkillMenu({ isBusy: () => false });
  menu.update({ desktop: true }); await flush();
  ids['message-input'].value = '/sk'; ids['message-input'].listeners.input();
  assert.equal(ids['skill-menu'].hidden, false);
  assert.equal(ids['skill-list'].children.length, 1);
  assert.match(ids['skill-list'].children[0].children[0].textContent, /skill-creator/);
  ids['message-input'].listeners.keydown({ key: 'Escape' });
  assert.equal(ids['skill-menu'].hidden, true);
  ids['message-input'].value = '/unknown'; ids['message-input'].listeners.input();
  assert.equal(ids['skill-list'].children.length, 0);
  assert.match(ids['skill-status'].textContent, /일치하는 스킬/);
  assert.equal(requests.length, 1);
});

test('busy state prevents skill insertion and chat completion refresh adds saved skills', async t => {
  const { ids, requests } = await fixture(t);
  let busy = false;
  const menu = createSkillMenu({ isBusy: () => busy });
  menu.update({ desktop: true }); await flush();
  const button = ids['skill-list'].children[0];
  busy = true; menu.sync();
  assert.equal(ids['skill-toggle'].disabled, true);
  await button.listeners.click();
  assert.equal(ids['message-input'].value, '');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { skills: [{ name: 'new-skill', description: '새로 만든 작업' }] } }) });
  await menu.refresh();
  busy = false; menu.sync();
  ids['skill-list'].children[0].listeners.click();
  assert.equal(ids['message-input'].value, '/new-skill ');
  assert.equal(requests.length, 1);
});

test('failed skill lookup gives safe retry state instead of claiming installation', async t => {
  const { ids } = await fixture(t);
  globalThis.fetch = async () => { throw Error('/private/secret/path'); };
  const menu = createSkillMenu({ isBusy: () => false });
  menu.update({ desktop: true }); await flush();
  assert.match(ids['skill-status'].textContent, /불러오지 못/);
  assert.doesNotMatch(ids['skill-status'].textContent, /private|secret|설치됨/);
  assert.equal(ids['skill-list'].children.length, 0);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { skills: [] } }) });
  await ids['skill-toggle'].listeners.click();
  assert.match(ids['skill-status'].textContent, /스킬 만들기/);
});
