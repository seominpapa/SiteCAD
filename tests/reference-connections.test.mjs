import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReferenceConnections, referenceCatalog } from '../lib/reference-connections.mjs';

function setup() {
  let value = null; let calls = 0;
  const store = { read: async () => structuredClone(value), write: async next => { value = structuredClone(next); }, remove: async () => { value = null; } };
  const references = createReferenceConnections({ store, apiFactory: ({ readCredentials }) => ({
    geocode: async input => { const credentials = await readCredentials(); if (!credentials?.apiKey) throw Error('missing'); calls++; return { point: { x: 126.9784, y: 37.5667 }, crs: 'EPSG:4326', ...input }; },
  }), now: () => new Date('2026-10-22T00:00:00Z') });
  return { references, saved: () => value, calls: () => calls };
}

test('curated references list keeps built-in tools and keyed API without development REA', async () => {
  assert.deepEqual(referenceCatalog.map(item => item.id), ['sitecad', 'web', 'standards', 'vworld', 'terrain']);
  const terrain = referenceCatalog.find(item => item.id === 'terrain');
  assert.equal(terrain.kind, 'local_source');
  assert.equal(terrain.status, 'source_required');
  assert.match(terrain.description, /광주시.*자동.*다른 지역은 원본 등록/);
  assert.equal(new URL(terrain.url).hostname, 'www.vworld.kr');
  const { references } = setup();
  assert.equal((await references.status()).vworld.configured, false);
  await assert.rejects(references.test(), /키/);
});

test('VWorld keys save only to the dedicated store and are absent from all settings responses', async () => {
  const { references, saved, calls } = setup();
  const key = `private-vworld-${randomUUID()}`;
  const status = await references.save({ apiKey: key, domain: 'https://sitecad.example/' });
  assert.equal(saved().apiKey, key);
  assert.equal(status.vworld.configured, true);
  assert.equal(status.vworld.domain, 'https://sitecad.example');
  assert.doesNotMatch(JSON.stringify(status), /private-vworld/);
  assert.equal(calls(), 0, 'saving is not a live API test');
  const checked = await references.test();
  assert.equal(checked.ok, true);
  assert.equal(calls(), 1);
  assert.equal((await references.status()).vworld.lastCheck.ok, true);
  await references.save({ apiKey: randomUUID() });
  assert.equal((await references.status()).vworld.lastCheck, undefined);
  await references.remove();
  assert.equal(saved(), null);
  assert.equal((await references.status()).vworld.configured, false);
  await assert.rejects(references.test(), /키/);
});

test('credential and domain validation reject malformed inputs before touching the store', async () => {
  const { references, saved } = setup();
  const apiKey = randomUUID();
  for (const input of [{}, { apiKey: '' }, { apiKey: 'short' }, { apiKey: `${apiKey}\ninvalid` }, { apiKey, extra: true }, { apiKey, domain: 'javascript:alert(1)' }, { apiKey, domain: 'https://user:secret@example.org' }, { apiKey, domain: 'https://example.org/?key=private' }]) await assert.rejects(references.save(input));
  assert.equal(saved(), null);
  const unavailable = createReferenceConnections({});
  await assert.rejects(unavailable.save({ apiKey }), /저장/);
});

test('provider errors cannot expose API keys or request URLs through connection status', async () => {
  let value;
  const apiKey = randomUUID();
  const references = createReferenceConnections({ store: { read: async () => value, write: async next => { value = next; } }, apiFactory: () => ({ geocode: async () => { throw Error(`https://api.vworld.kr/req/address?key=${apiKey}`); } }) });
  await references.save({ apiKey });
  const result = await references.test();
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify({ result, status: await references.status() }), /private-vworld|\?key=/);
  assert.equal(JSON.stringify({ result, status: await references.status() }).includes(apiKey), false);
});
