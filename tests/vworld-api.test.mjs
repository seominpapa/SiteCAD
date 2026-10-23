import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createVworldApi } from '../lib/vworld-api.mjs';

const apiKey = randomUUID();
const credentials = async () => ({ apiKey, domain: 'http://localhost:4317' });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const pointResponse = { response: { status: 'OK', refined: { text: '서울특별시 강남구 봉은사로 524' }, result: { crs: 'EPSG:4326', point: { x: '127.0593', y: '37.5122' } } } };
const bbox = [127.059, 37.512, 127.060, 37.513];
const ring = [[127.0591, 37.5121], [127.0595, 37.5121], [127.0595, 37.5125], [127.0591, 37.5121]];
const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { pnu: '1168010500100010000', addr: '서울특별시 강남구 삼성동 1', owner: '개인정보', jiga: '민감값' }, id: 'server-internal-id' };
const featureResponse = (features = [feature], total = features.length) => ({ response: { status: 'OK', record: { total: String(total), current: String(features.length) }, result: { featureCollection: { type: 'FeatureCollection', features } } } });
const service = request => createVworldApi({ readCredentials: credentials, request });

test('requires locally configured credentials without making a network request', async () => {
  for (const readCredentials of [async () => null, async () => ({}), async () => { throw new Error(apiKey); }]) {
    const api = createVworldApi({ readCredentials, request: () => assert.fail('must not request') });
    await assert.rejects(api.geocode({ address: '봉은사로 524' }), error => /VWorld.*설정/.test(error.message) && !error.message.includes(apiKey));
    await assert.rejects(api.parcels({ bbox }));
  }
});

test('native transport pins public DNS, verifies TLS and rejects mixed private DNS', async context => {
  let answers = [{ address: '125.60.1.2', family: 4 }];
  const dnsStub = context.mock.method(dns, 'lookup', async () => answers);
  let requests = 0;
  const httpsStub = context.mock.method(https, 'request', (url, options, onResponse) => {
    requests++;
    assert.equal(url.origin, 'https://api.vworld.kr');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, 'api.vworld.kr');
    options.lookup('api.vworld.kr', {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, answers[0].address); assert.equal(family, answers[0].family);
    });
    options.lookup('api.vworld.kr', { all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [answers[0]]);
    });
    const req = new EventEmitter();
    req.end = () => onResponse(Object.assign(Readable.from([Buffer.from(JSON.stringify(pointResponse))]), { statusCode: 200, headers: { 'content-type': 'application/json' } }));
    return req;
  });
  syncBuiltinESMExports();
  try {
    const api = createVworldApi({ readCredentials: credentials });
    await api.geocode({ address: '봉은사로 524' });
    answers = [{ address: '2606:4700:4700::1111', family: 6 }];
    await api.geocode({ address: '봉은사로 524' });
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::']) {
      answers = [{ address: '125.60.1.2', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }];
      await assert.rejects(api.geocode({ address: '봉은사로 524' }));
    }
    assert.equal(requests, 2);
  } finally { dnsStub.mock.restore(); httpsStub.mock.restore(); syncBuiltinESMExports(); }
});

test('uses official geocoding parameters and returns only sanitized coordinates and provenance', async () => {
  const result = await service(async (url, options) => {
    assert.equal(url.origin, 'https://api.vworld.kr');
    assert.equal(url.pathname, '/req/address');
    for (const [name, value] of Object.entries({ service: 'address', version: '2.0', request: 'getcoord', format: 'json', type: 'ROAD', crs: 'EPSG:4326', refine: 'true', simple: 'false', key: apiKey, domain: 'http://localhost:4317/' })) assert.equal(url.searchParams.get(name), value);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.maxBytes, 2 * 1024 * 1024);
    return json(pointResponse);
  }).geocode({ address: '봉은사로 524' });
  assert.deepEqual(result.point, { x: 127.0593, y: 37.5122 });
  assert.equal(result.address, pointResponse.response.refined.text);
  assert.equal(result.type, 'ROAD');
  assert.equal(result.crs, 'EPSG:4326');
  assert.equal(result.untrusted, true);
  assert.match(result.sourceUrl, /^https:\/\/www.vworld.kr\/dev\//);
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.ok(!JSON.stringify(result).includes(apiKey));
});

test('accepts parcel address geocoding and excludes unknown input fields from the request', async () => {
  await service(async url => {
    assert.equal(url.searchParams.get('type'), 'PARCEL');
    assert.equal(url.searchParams.get('url'), null);
    return json(pointResponse);
  }).geocode({ address: '삼성동 1', type: 'PARCEL', url: 'http://localhost' });
});

test('rejects invalid address and address type before reading credentials', async () => {
  const api = createVworldApi({ readCredentials: () => assert.fail('must not read'), request: () => assert.fail('must not request') });
  for (const input of [{}, { address: 1 }, { address: ' ' }, { address: 'x'.repeat(301) }, { address: 'a\nprivate' }, { address: 'a', type: 'OTHER' }]) await assert.rejects(api.geocode(input));
});

test('returns only parcel geometry, pnu and address and explicitly limits requests', async () => {
  const result = await service(async url => {
    assert.equal(url.pathname, '/req/data');
    for (const [name, value] of Object.entries({ service: 'data', request: 'GetFeature', version: '2.0', data: 'LP_PA_CBND_BUBUN', crs: 'EPSG:4326', format: 'json', size: '50', page: '1', geometry: 'true', attribute: 'true', columns: 'pnu,addr', geomFilter: `BOX(${bbox.join(',')})` })) assert.equal(url.searchParams.get(name), value);
    return json(featureResponse([feature], 100));
  }).parcels({ bbox });
  assert.equal(result.type, 'FeatureCollection');
  assert.equal(result.count, 1);
  assert.deepEqual(result.bbox, bbox);
  assert.equal(result.possiblyTruncated, true);
  assert.deepEqual(result.features[0], { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { pnu: feature.properties.pnu, address: feature.properties.addr } });
  assert.ok(!JSON.stringify(result).includes('개인정보'));
  assert.ok(!JSON.stringify(result).includes('민감값'));
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.notEqual(result.features[0].geometry.coordinates[0], ring);
});

test('accepts multipolygons with closed rings and bounds result count', async () => {
  const multi = { ...feature, geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] } };
  const result = await service(async url => { assert.equal(url.searchParams.get('size'), '1'); return json(featureResponse([multi], 1)); }).parcels({ bbox, maxFeatures: 1 });
  assert.equal(result.features[0].geometry.type, 'MultiPolygon');
  assert.equal(result.possiblyTruncated, true);
  await assert.rejects(service(async () => json(featureResponse([feature, feature]))).parcels({ bbox, maxFeatures: 1 }), /응답/);
});

test('rejects invalid, excessive and non-Korean bbox requests before network access', async () => {
  const api = service(() => assert.fail('must not request'));
  for (const invalid of [null, [127, 37], [127, 37, '128', 38], [127, 37, NaN, 38], [127, 37, 126, 38], [0, 0, 0.001, 0.001], [127, 37, 127.1, 37.1], [127, 37, 127.03, 37.00001]]) await assert.rejects(api.parcels({ bbox: invalid }));
  for (const maxFeatures of [0, 101, 1.5, '10']) await assert.rejects(api.parcels({ bbox, maxFeatures }));
});

test('rejects malformed, unclosed, non-finite and non-geographic geometry', async () => {
  const geometries = [null, { type: 'Point', coordinates: [127, 37] }, { type: 'Polygon', coordinates: [] }, { type: 'Polygon', coordinates: [[[127, 37], [127.1, 37], [127.1, 37.1], [127, 37.1]]] }, { type: 'Polygon', coordinates: [[[127, 37], [127.1, 37], [Infinity, 37.1], [127, 37]]] }, { type: 'Polygon', coordinates: [[[100, 10], [100.1, 10], [100.1, 10.1], [100, 10]]] }, { type: 'Polygon', coordinates: [[[127, 37, 0], [127.1, 37], [127.1, 37.1], [127, 37]]] }];
  for (const geometry of geometries) await assert.rejects(service(async () => json(featureResponse([{ ...feature, geometry }]))).parcels({ bbox }), /응답/);
  const huge = Array.from({ length: 20_001 }, () => [127.0591, 37.5121]);
  await assert.rejects(service(async () => json(featureResponse([{ ...feature, geometry: { type: 'Polygon', coordinates: [huge] } }]))).parcels({ bbox }), /응답/);
});

test('rejects unexpected source CRS and non-finite geocoding coordinates', async () => {
  for (const result of [{ crs: 'EPSG:3857', point: { x: 127, y: 37 } }, { crs: { arbitrary: 'EPSG:4326' }, point: { x: 127, y: 37 } }, { crs: 'EPSG:4326', point: { x: 'NaN', y: 37 } }, { crs: 'EPSG:4326', point: { x: 0, y: 0 } }, { crs: 'EPSG:4326', point: { x: '', y: 37 } }]) await assert.rejects(service(async () => json({ response: { status: 'OK', result } })).geocode({ address: '삼성동 1' }), /응답/);
  for (const crs of ['EPSG:4326wrong', { type: 'name', properties: { name: 'EPSG:3857', comment: 'EPSG:4326' } }]) {
    const response = featureResponse();
    await assert.rejects(service(async () => json({ response: { ...response.response, result: { featureCollection: { ...response.response.result.featureCollection, crs } } } })).parcels({ bbox }), /응답/);
  }
});

test('normalizes provider empty results without leaking provider fields', async () => {
  const api = service(async () => json({ response: { status: 'NOT_FOUND', error: { text: apiKey } } }));
  await assert.rejects(api.geocode({ address: '없는 주소' }), /찾지 못/);
  const result = await api.parcels({ bbox });
  assert.deepEqual(result.features, []);
  assert.equal(result.count, 0);
  assert.equal(result.possiblyTruncated, false);
});

test('does not leak provider errors, key-bearing values, request URLs or thrown errors', async () => {
  for (const request of [async () => { throw new Error(`https://api.vworld.kr/req/data?key=${apiKey}`); }, async () => json({ response: { status: 'ERROR', error: { text: apiKey } } }), async () => json({ response: { ...pointResponse.response, refined: { text: apiKey } } }), async () => new Response(apiKey, { status: 302, headers: { location: 'http://localhost' } }), async () => new Response(apiKey, { status: 500 }), async () => new Response(apiKey, { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(service(request).geocode({ address: '삼성동 1' }), error => !error.message.includes(apiKey) && !error.message.includes('req/data?'));
  }
});

test('rejects oversized, encoded or malformed provider JSON', async () => {
  for (const response of [new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } }), new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), new Response('{bad-json', { headers: { 'content-type': 'application/json' } })]) await assert.rejects(service(async () => response).parcels({ bbox }), error => !error.message.includes(apiKey));
});

test('validates credential fields without passing hostile domain URLs into requests', async () => {
  for (const value of [{ apiKey: 'bad key' }, { apiKey, domain: 'file:///etc/passwd' }, { apiKey, domain: 'https://user:pass@example.com' }, { apiKey, domain: 'https://example.com/?secret=1' }]) await assert.rejects(createVworldApi({ readCredentials: async () => value, request: () => assert.fail('must not request') }).parcels({ bbox }), /설정/);
});
