import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentUtilities } from '../lib/agent-utilities.mjs';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createTerrainData } from '../lib/terrain-data.mjs';
import { createMcpHandler } from '../lib/sitecad-mcp.mjs';
import { researchTools } from '../lib/research-mcp.mjs';

const TEST_API_KEY = 'valid-test-key';
const address = '경기도 광주시 검증로 1';
const point = { x: 127.246, y: 37.409 };
const sourceUrl = 'https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do';
const geocoded = { address, point, crs: 'EPSG:4326', sourceUrl, retrievedAt: '2026-10-23T00:00:00Z' };
const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[127.2455, 37.4085], [127.2465, 37.4095]] }, properties: { ELE_ALT: 100 } };
const parcel = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[127.2458, 37.4088], [127.2462, 37.4088], [127.2462, 37.4092], [127.2458, 37.4092], [127.2458, 37.4088]]] }, properties: { pnu: '4161010100100010000' } };

async function fixture(options, check) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-address-preparation-'));
  const terrain = await createTerrainData({ dataDir });
  const bytes = Buffer.from(JSON.stringify(options.geojson ?? { type: 'FeatureCollection', features: [feature] }));
  const geocodes = [], parcelQueries = [], downloads = [], cadJobs = [];
  const context = options.context ?? { documentId: 7, revision: 1, units: 4, selection: [], entities: [] };
  let controller, action;
  const agentUtilities = createAgentUtilities({ dataDir,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, requestOptions) => {
      downloads.push(url.href);
      if (options.request) return options.request(url, requestOptions, bytes);
      return new Response(bytes, { headers: { 'content-type': 'application/geo+json' } });
    },
  });
  const runtime = { start: async () => {}, stop: async () => {}, cancel: async () => {}, status: () => ({}),
    chat: async () => {
      const handle = createMcpHandler((method, input) => controller.callCad(method, input), researchTools);
      await action(handle);
      return { reply: '주소 준비 검증용 응답' };
    },
  };
  const run = async (next, input = { address }) => {
    let result, done = false;
    action = next ?? (async handle => { result = await handle('tools/call', { name: 'cad_prepare_site', arguments: input }); });
    const pending = controller.chat({ message: address, context, history: [] });
    void pending.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      const job = await controller.pollCad({ waitMs: 5 });
      if (!job) continue;
      cadJobs.push(job.method);
      assert.equal(controller.claimCad(job.id).valid, true);
      if (job.method === 'context') controller.completeCad(job.id, context);
      else if (job.method === 'parcel_context') controller.completeCad(job.id, { context: options.anchorContext ?? context, georeference: null });
      else { await controller.cancel(); assert.fail(`Preparation must not mutate or save CAD: ${job.method}`); }
    }
    const reply = await pending;
    return { result, reply };
  };
  try {
    controller = await createDesktopController({ dataDir, terrainData: terrain, agentUtilities,
      codexPath: '/app/codex', nodePath: '/app/node', secureStore: {}, bridgeTimeoutMs: 1000,
      authFactory: async () => ({ status: () => ({ loggedIn: true }), getAccessToken: async () => 'test-token', close: async () => {} }),
      runtimeFactory: async () => runtime,
      referenceSecretStore: { read: async () => ({ apiKey: TEST_API_KEY }) },
      referenceApiFactory: () => ({
        geocode: async input => { geocodes.push(input); return options.geocode ? options.geocode(input) : structuredClone(geocoded); },
        parcels: async input => {
          parcelQueries.push(input);
          return { type: 'FeatureCollection', crs: 'EPSG:4326', bbox: input.bbox, features: options.parcels ?? [parcel],
            count: (options.parcels ?? [parcel]).length, possiblyTruncated: false, sourceUrl, retrievedAt: geocoded.retrievedAt };
        },
      }),
    });
    await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
    await check({ controller, run, terrain, bytes, geocodes, parcelQueries, downloads, cadJobs });
  } finally { await controller?.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test('address preparation downloads and registers genuine terrain with current-turn parcel and terrain sources, without changing CAD', async () => {
  await fixture({}, async ({ run, terrain, bytes, downloads, parcelQueries, cadJobs }) => {
    const { result, reply } = await run();
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const prepared = result.structuredContent;
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.address, address);
    assert.deepEqual(prepared.point, point);
    assert.equal(prepared.radius_m, 100);
    assert.match(prepared.parcelSourceId, /^geo-/);
    assert.match(prepared.terrainSourceId, /^geo-/);
    assert.notEqual(prepared.parcelSourceId, prepared.terrainSourceId);
    assert.equal(prepared.parcels.featureCount, 1);
    assert.equal(prepared.terrain.featureCount, 1);
    assert.equal(prepared.terrain.verticalDatum, 'unknown');
    assert.equal(prepared.terrain.unitAssumption, 'm');
    assert.equal(prepared.terrain.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(prepared.download.reused, false);
    assert.match(prepared.saveName, /^[^/\\]+\.dwg$/);
    assert.equal(downloads.length, 1);
    assert.equal(new URL(downloads[0]).hostname, 'gis.gjcity.go.kr');
    assert.deepEqual(parcelQueries[0].bbox, prepared.bbox);
    assert.equal(parcelQueries[0].maxFeatures, 100);
    const records = await terrain.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, prepared.terrain.datasetId);
    assert.equal((await terrain.query({ datasetId: records[0].id, bbox: prepared.bbox })).count, 1);
    assert.ok(reply.sources.some(source => source.id === prepared.parcelSourceId));
    assert.ok(reply.sources.some(source => source.id === prepared.terrainSourceId));
    assert.ok(cadJobs.length > 0);
    assert.ok(cadJobs.every(method => ['context', 'parcel_context'].includes(method)));
  });
});

test('unsupported resolved region stops before parcel lookup, download, registration or CAD mutation', async () => {
  await fixture({ geocode: async () => ({ ...geocoded, address: '서울특별시 중구 세종대로 110', point: { x: 126.9784, y: 37.5667 } }) }, async ({ run, terrain, downloads, parcelQueries }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.ok(result.structuredContent.message);
    assert.equal(parcelQueries.length, 0);
    assert.equal(downloads.length, 0);
    assert.deepEqual(await terrain.list(), []);
  });
});

test('ROAD not-found retries PARCEL, while authentication errors never retry another address type', async () => {
  await fixture({ geocode: async input => {
    if (input.type === 'ROAD') throw Error('해당 주소의 좌표를 찾지 못했습니다.');
    return structuredClone(geocoded);
  } }, async ({ run, geocodes }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 'ready');
    assert.deepEqual(geocodes.map(item => item.type), ['ROAD', 'PARCEL']);
  });
  await fixture({ geocode: async () => { throw Error('VWorld 인증정보를 확인해 주세요.'); } }, async ({ run, geocodes, downloads, terrain }) => {
    const { result } = await run();
    assert.equal(result.isError, true);
    assert.deepEqual(geocodes.map(item => item.type), ['ROAD']);
    assert.equal(downloads.length, 0);
    assert.deepEqual(await terrain.list(), []);
  });
});

test('no real parcels stops before downloading or registering terrain', async () => {
  await fixture({ parcels: [] }, async ({ run, downloads, terrain }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.equal(downloads.length, 0);
    assert.deepEqual(await terrain.list(), []);
  });
});

test('a valid terrain source without features around the address is reported unavailable without CAD changes', async () => {
  const distant = { ...feature, geometry: { type: 'LineString', coordinates: [[127.25, 37.42], [127.251, 37.421]] } };
  await fixture({ geojson: { type: 'FeatureCollection', features: [distant] } }, async ({ run, downloads, terrain }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.equal(downloads.length, 1);
    assert.equal((await terrain.list()).length, 1);
  });
});

test('invalid automatic address requests fail before network or CAD work', async () => {
  await fixture({}, async ({ run, geocodes, downloads, cadJobs }) => {
    for (const input of [{ address: '' }, { address, radius_m: 251 }, { address, url: 'https://untrusted.example.org/source.geojson' }, { address, radius_m: 12.5 }]) {
      const { result } = await run(undefined, input);
      assert.equal(result.isError, true);
    }
    assert.equal(geocodes.length, 0);
    assert.equal(downloads.length, 0);
    assert.deepEqual(cadJobs, []);
  });
});

test('an existing drawing without a geographic anchor is preserved before any network lookup', async () => {
  const context = { documentId: 7, revision: 1, units: 4, selection: [], entities: [{ handle: 'A', type: 'Line', layer: '0' }] };
  await fixture({ context }, async ({ run, geocodes, parcelQueries, downloads, terrain }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.equal(geocodes.length, 0);
    assert.equal(parcelQueries.length, 0);
    assert.equal(downloads.length, 0);
    assert.deepEqual(await terrain.list(), []);
  });
});

test('unitless drawings and drawing changes during preflight stop before network lookup', async () => {
  const context = { documentId: 7, revision: 1, units: 0, selection: [], entities: [] };
  await fixture({ context }, async ({ run, geocodes, downloads }) => {
    const { result } = await run();
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.deepEqual(geocodes, []);
    assert.deepEqual(downloads, []);
  });
  await fixture({ anchorContext: { ...context, units: 4, revision: 2 } }, async ({ run, geocodes, downloads }) => {
    const { result } = await run();
    assert.equal(result.isError, true);
    assert.deepEqual(geocodes, []);
    assert.deepEqual(downloads, []);
  });
});

test('invalid heights and ArcGIS transfer-limit responses are refused before registration or insertion', async () => {
  for (const geojson of [
    { type: 'FeatureCollection', features: [{ ...feature, properties: { ELE_ALT: 'not-a-height' } }] },
    { type: 'FeatureCollection', features: [feature], exceededTransferLimit: true },
  ]) await fixture({ geojson }, async ({ run, terrain }) => {
    const { result } = await run();
    assert.equal(result.isError, true);
    assert.deepEqual(await terrain.list(), []);
  });
});

test('terrain exceeding projection contour limits is refused during preparation before any CAD insertion', async () => {
  const coordinates = Array.from({ length: 501 }, (_, index) => {
    const y = 37.4088 + index * 0.0000005;
    return [[127.2458, y], [127.2462, y]];
  });
  const geojson = { type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'MultiLineString', coordinates }, properties: { ELE_ALT: 100 },
  }] };
  await fixture({ geojson }, async ({ run, cadJobs }) => {
    const { result } = await run();
    assert.equal(result.isError, true);
    assert.ok(cadJobs.every(method => ['context', 'parcel_context'].includes(method)));
  });
});

test('an existing verified dataset for the exact address query is reused with fresh per-turn source IDs', async () => {
  await fixture({}, async ({ run, terrain, downloads }) => {
    const first = (await run()).result;
    assert.notEqual(first.isError, true, JSON.stringify(first));
    const second = (await run()).result;
    assert.notEqual(second.isError, true, JSON.stringify(second));
    assert.equal(second.structuredContent.status, 'ready');
    assert.equal(second.structuredContent.download.reused, true);
    assert.equal(second.structuredContent.terrain.datasetId, first.structuredContent.terrain.datasetId);
    assert.notEqual(second.structuredContent.parcelSourceId, first.structuredContent.parcelSourceId);
    assert.notEqual(second.structuredContent.terrainSourceId, first.structuredContent.terrainSourceId);
    assert.equal(downloads.length, 1);
    assert.equal((await terrain.list()).length, 1);
  });
});

test('a corrupted registered source is refused without silently downloading another copy', async () => {
  await fixture({}, async ({ run, terrain, downloads }) => {
    const first = await run();
    assert.notEqual(first.result.isError, true, JSON.stringify(first.result));
    const download = first.reply.details.find(item => item.tool === 'download');
    assert.ok(download?.path);
    await writeFile(download.path, '{}');
    const second = await run();
    assert.equal(second.result.isError, true);
    assert.equal(downloads.length, 1);
    assert.equal((await terrain.list()).length, 1);
  });
});

test('cancelling a pending automatic download prevents persistent terrain registration', async () => {
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  await fixture({ request: async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  } }, async ({ controller, run, terrain }) => {
    const pending = run();
    const startedDownload = await Promise.race([downloading.then(() => true), pending.then(() => false)]);
    if (!startedDownload) { await pending; assert.fail('Automatic download did not start'); }
    await controller.cancel();
    await assert.rejects(pending, /취소/);
    assert.deepEqual(await terrain.list(), []);
  });
});
