import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPanel } from '../public/chat-panel.js';

test('chat panel can collapse and restore while approvals stay visible', t => {
  const before = globalThis.document;
  const collapsed = new Set();
  const element = () => ({ hidden: false, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } });
  const ids = Object.fromEntries(['workspace', 'sitecad-chat-panel', 'chat-collapse', 'chat-expand', 'message-input'].map(id => [id, element()]));
  ids.workspace.classList = { toggle(name, enabled) { enabled ? collapsed.add(name) : collapsed.delete(name); } };
  globalThis.document = { getElementById: id => ids[id] };
  t.after(() => { globalThis.document = before; });
  const panel = createChatPanel();
  ids['chat-collapse'].listeners.click();
  assert.equal(ids['sitecad-chat-panel'].hidden, true);
  assert.equal(ids['chat-expand'].hidden, false);
  assert.equal(ids['chat-expand']['aria-expanded'], 'false');
  assert.ok(collapsed.has('chat-collapsed'));
  ids['chat-expand'].listeners.click();
  assert.equal(ids['sitecad-chat-panel'].hidden, false);
  assert.equal(ids['chat-expand'].hidden, true);
  assert.equal(ids['chat-collapse']['aria-expanded'], 'true');
  ids['chat-collapse'].listeners.click();
  panel.update({ approvals: [{ id: 'pending' }] });
  assert.equal(ids['sitecad-chat-panel'].hidden, false);
  assert.equal(collapsed.size, 0);
});
