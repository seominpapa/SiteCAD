import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

test('steering and stop use the existing chat while its NDJSON response remains open', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const messages = [];
  const server = createApp({ desktop: {
    status: async () => ({ desktop: true, oauth: { connected: true }, active: true }),
    chat: () => { entered(); return new Promise(resolve => { finish = resolve; }); },
    steer: async value => { messages.push(value); return { accepted: true }; },
    cancel: async () => { finish({ reply: '정지했습니다.' }); return null; },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { finish?.({ reply: '정리' }); server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', ...headers,
  }, body: JSON.stringify(body) });
  const chatId = '00000000-0000-4000-8000-000000000001';
  const stream = await request('/api/chat', { message: '도면 확인', chatId, context: { documentId: 1, revision: 0, units: 4, selection: [], entities: [] }, history: [] }, { Accept: 'application/x-ndjson' });
  assert.equal(stream.status, 200); await started;
  assert.equal((await request('/api/desktop/steer', { message: '비밀' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/desktop/steer', { message: '비밀' }, { 'Content-Type': 'text/plain' })).status, 415);
  const response = await request('/api/desktop/steer', { message: '저장하지 말고 단위만 알려줘', chatId });
  assert.deepEqual(await response.json(), { ok: true, data: { accepted: true } });
  assert.deepEqual(messages, [{ message: '저장하지 말고 단위만 알려줘', chatId }]);
  assert.equal((await request('/api/desktop/cancel', {})).status, 200);
  assert.match(await stream.text(), /정지했습니다/);
});
