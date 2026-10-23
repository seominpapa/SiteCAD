import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearch, researchTools } from '../lib/research-mcp.mjs';

const document = { url: 'https://example.org/standard', title: 'Standard', content: 'Maximum slope 1:12', sha256: 'a'.repeat(64), retrievedAt: '2026-10-22T00:00:00Z', contentType: 'text/html', untrusted: true };
const design = sourceId => ({ title: '경사로 개념도', assumptions: ['예시 높이 300mm'], dimensions: [{ name: '높이', value: 300, unit: 'mm', basis: 'assumption' }, { name: '경사비', value: 12, unit: 'ratio', basis: 'source', sourceId }], sourceIds: [sourceId] });
test('research tools preserve retrieved evidence and bind design dimensions to actual sources', async () => {
  const research = createResearch({ fetchDocument: async () => document });
  assert.deepEqual(researchTools.map(tool => tool.name), ['cad_fetch', 'cad_design_note', 'cad_vworld_geocode', 'cad_vworld_parcels', 'cad_terrain_sources', 'cad_terrain_query']);
  const source = await research.call('fetch', { url: document.url });
  assert.equal(source.content, document.content);
  assert.equal(source.untrusted, true);
  const note = await research.call('design', design(source.id));
  assert.equal(note.conceptual, true);
  const report = research.report();
  assert.equal(report.sources[0].id, source.id);
  assert.equal(report.sources[0].sha256, document.sha256);
  assert.equal(report.sources[0].content, undefined);
  assert.equal(report.design.title, note.title);
  report.design.assumptions.push('changed');
  assert.equal(research.report().design.assumptions.length, 1);
});

test('terrain sources are local and source cache cannot be supplied by a model or cross-contaminated with parcels', async () => {
  const terrain = { type: 'FeatureCollection', crs: 'EPSG:4326', features: [{ geometry: { type: 'Point', coordinates: [127, 37] }, properties: { elevation_m: 30 } }],
    count: 1, sourceUrl: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30185', retrievedAt: document.retrievedAt, sourceKind: 'local-file' };
  const research = createResearch({ terrainSources: async () => ({ datasets: [{ id: 'terrain-local' }] }), terrainQuery: async () => terrain });
  assert.deepEqual(await research.call('terrain_sources', {}), { datasets: [{ id: 'terrain-local' }] });
  await assert.rejects(research.call('terrain_sources', { path: '/private/file' }));
  const source = await research.call('terrain_query', { bbox: [127, 37, 127.001, 37.001] });
  assert.equal(research.terrainSource(source.id).features[0].properties.elevation_m, 30);
  source.features.length = 0;
  assert.equal(research.terrainSource(source.id).features.length, 1);
  assert.throws(() => research.parcelSource(source.id));
  assert.throws(() => createResearch({}).terrainSource(source.id));
  assert.equal(research.report().sources[0].features, undefined);
  assert.equal(research.report().sources[0].sourceKind, 'local-file');
});
test('downloaded terrain research preserves the real public origin and original download time', async () => {
  const terrain = { sourceKind: 'public-download', sourceLabel: '공개 다운로드 원본(원출처·표고 기준 미검증)',
    sourceUrl: 'https://data.example.org/contours.geojson', downloadedAt: '2026-10-22T00:00:00Z',
    retrievedAt: '2026-10-23T00:00:00Z', sourceSha256: 'a'.repeat(64), originalCRS: 'EPSG:5179', verticalDatum: 'unknown', crs: 'EPSG:4326', count: 1 };
  const research = createResearch({ terrainQuery: async () => terrain });
  const source = await research.call('terrain_query', { bbox: [127, 37, 127.001, 37.001] });
  assert.equal(research.terrainSource(source.id).sourceUrl, terrain.sourceUrl);
  const evidence = research.report().sources[0];
  assert.equal(evidence.url, terrain.sourceUrl);
  for (const key of ['sourceKind', 'sourceLabel', 'downloadedAt', 'retrievedAt', 'sourceSha256', 'originalCRS', 'verticalDatum']) assert.equal(evidence[key], terrain[key]);
});

test('unretrieved citations and malformed dimensions cannot become design evidence', async () => {
  const research = createResearch({ fetchDocument: async () => document });
  await assert.rejects(research.call('design', design('invented')), /출처/);
  const source = await research.call('fetch', { url: document.url });
  for (const changed of [{ dimensions: [{ name: '높이', value: Infinity, unit: 'mm', basis: 'assumption' }] }, { assumptions: [] }, { sourceIds: [] }, { extra: 'bad' }]) {
    await assert.rejects(research.call('design', { ...design(source.id), ...changed }));
  }
  await assert.rejects(research.call('fetch', { url: document.url, headers: {} }));
  await assert.rejects(research.call('other', {}));
});
test('research bounds network requests and reuses identical URLs within one turn', async () => {
  let count = 0;
  const research = createResearch({ fetchDocument: async ({ url }) => { count++; return { ...document, url }; } });
  const first = await research.call('fetch', { url: document.url });
  assert.equal((await research.call('fetch', { url: document.url })).id, first.id);
  assert.equal(count, 1);
  for (let i = 0; i < 5; i++) await research.call('fetch', { url: `${document.url}/${i}` });
  await assert.rejects(research.call('fetch', { url: `${document.url}/overflow` }), /최대/);
  assert.deepEqual(createResearch({ fetchDocument: async () => document }).report(), { sources: [] });
});

test('VWorld reads retain CRS and provenance but omit parcel geometry from source cards', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[126.9, 37.5], [126.901, 37.5], [126.901, 37.501], [126.9, 37.5]]] };
  const research = createResearch({ fetchDocument: async () => document,
    geocode: async () => ({ point: { x: 126.9, y: 37.5 }, crs: 'EPSG:4326', sourceUrl: 'https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do', retrievedAt: document.retrievedAt }),
    parcels: async () => ({ type: 'FeatureCollection', features: [{ geometry }], count: 1, crs: 'EPSG:4326', sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral', retrievedAt: document.retrievedAt }),
  });
  const point = await research.call('geocode', { address: '서울특별시 중구 세종대로 110' });
  assert.equal(point.crs, 'EPSG:4326');
  assert.equal(point.kind, 'geodata');
  const parcels = await research.call('parcels', { bbox: [126.9, 37.5, 126.901, 37.501] });
  assert.deepEqual(parcels.features[0].geometry, geometry);
  const report = research.report();
  assert.equal(report.sources.length, 2);
  assert.equal(report.sources[1].count, 1);
  assert.equal(report.sources[1].features, undefined);
  assert.equal(report.sources[1].url.includes('key='), false);
  assert.equal(report.sources[1].crs, 'EPSG:4326');
  assert(researchTools.some(tool => tool.name === 'cad_vworld_parcels'));
});


test('parcel cache accepts only real parcel source ids and returns defensive copies', async () => {
  const result = { type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon', coordinates: [] } }], count: 1, crs: 'EPSG:4326', sourceUrl: document.url, retrievedAt: document.retrievedAt };
  const research = createResearch({ parcels: async () => result, geocode: async () => ({ point: { x: 127, y: 38 } }) });
  assert.throws(() => research.parcelSource('invented'), /출처/);
  const point = await research.call('geocode', {});
  assert.throws(() => research.parcelSource(point.id), /출처/);
  const source = await research.call('parcels', {});
  source.features.length = 0;
  const cached = research.parcelSource(source.id);
  assert.equal(cached.features.length, 1);
  cached.features.length = 0;
  assert.equal(research.parcelSource(source.id).features.length, 1);
  assert.throws(() => createResearch({}).parcelSource(source.id), /출처/);
});
