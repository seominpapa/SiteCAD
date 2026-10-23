import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectTerrain } from '../lib/terrain-projection.mjs';
import { projectParcels } from '../lib/parcel-projection.mjs';
import { parseGeoReference, metadataText } from '../public/geo-reference.js';

const a = [126.978, 37.5665], b = [126.979, 37.5665], c = [126.979, 37.5675];
const feature = (type = 'LineString', coordinates = [a, b], elevation_m = 27.5) => ({ type: 'Feature', geometry: { type, coordinates }, properties: { elevation_m } });
const source = (features = [feature()], overrides = {}) => ({
  type: 'FeatureCollection', crs: 'EPSG:4326', bbox: [126.978, 37.5665, 126.979, 37.5675], features, count: features.length,
  id: 'terrain-fixture', sourceUrl: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=DTMK_AJ&dsId=30185', retrievedAt: '2026-10-22T00:00:00.000Z',
  originalCRS: 'EPSG:5186', verticalDatum: 'unknown', sourceSha256: 'a'.repeat(64), possiblyTruncated: false, ...overrides,
});
const close = (actual, expected, tolerance = 0.002) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const parcel = () => projectParcels(source([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[a, b, c, [a[0], c[1]], a]] }, properties: {} }], {
  sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral',
}), { units: 4, x_mm: 1200, y_mm: -300 });

test('matches independent EPSG:5179 coordinates with real elevations and no interpolation', () => {
  const result = projectTerrain(source([feature(), feature('Point', c, -2.75)]), { units: 4 });
  const projected = [[953901.1653121515, 1952032.0809790879], [953989.4778875523, 1952031.5908961713]];
  const origin = [953945.6294420916, 1952087.3083653094];
  result.metadata.originProjectedM.forEach((value, axis) => close(value, origin[axis], 0.000002));
  result.entities[0].verticesMm.forEach((point, i) => point.forEach((value, axis) => close(value, (projected[i][axis] - origin[axis]) * 1000)));
  assert.equal(result.entities[0].kind, 'contour');
  assert.equal(result.entities[0].elevationM, 27.5);
  assert.equal(result.entities[0].closed, false);
  assert.deepEqual(result.entities[1], { kind: 'spot', positionMm: [result.entities[1].positionMm[0], result.entities[1].positionMm[1]], elevationM: -2.75 });
  assert.equal(result.summary.minElevationM, -2.75);
  assert.equal(result.summary.maxElevationM, 27.5);
  assert.equal(result.summary.verticalDatum, 'unknown');
});

test('reuses parcel origin, offset and units without changing model scale', () => {
  const anchor = parcel().metadata;
  const movedSource = source(undefined, { bbox: [126.977, 37.5664, 126.9795, 37.5678] });
  const result = projectTerrain(movedSource, { units: 4, georeference: anchor });
  assert.deepEqual(result.metadata.originLonLat, anchor.originLonLat);
  assert.deepEqual(result.metadata.originProjectedM, anchor.originProjectedM);
  assert.deepEqual(result.metadata.insertionMm, [1200, -300]);
  assert.deepEqual(result.entities[0].verticesMm, parcel().rings[0].verticesMm.slice(0, 2));
  assert.equal(result.metadata.modelScale, 1);
  assert.equal(result.metadata.kind, 'terrain');
  assert.equal(result.metadata.netAreaM2, null);
  assert.equal(result.metadata.ringCount, 0);
  for (const overrides of [{ units: 6 }, { x_mm: 0 }, { y_mm: 0 }]) assert.throws(() => projectTerrain(source(), { units: 4, georeference: anchor, ...overrides }));
});

test('splits MultiLineString into exact parts, preserves closed contours and counts features', () => {
  const result = projectTerrain(source([feature('MultiLineString', [[a, b], [a, b, c, a]], 40), feature('Point', c, 41)]), { units: 4 });
  assert.equal(result.entities.length, 3);
  assert.equal(result.entities[0].verticesMm.length, 2);
  assert.equal(result.entities[1].verticesMm.length, 3);
  assert.equal(result.entities[1].closed, true);
  assert.equal(result.summary.featureCount, 2);
  assert.equal(result.summary.contourCount, 2);
  assert.equal(result.summary.spotCount, 1);
  assert.equal(result.metadata.terrain.contourCount, 2);
  assert.equal(result.metadata.terrain.spotCount, 1);
});

test('retains source provenance and round-trips strict metadata without parcel quantities', () => {
  const input = source(undefined, { possiblyTruncated: true });
  const result = projectTerrain(input, { units: 6 });
  const hash = createHash('sha256').update(JSON.stringify(input.features.map(item => ({ geometry: item.geometry, elevation_m: item.properties.elevation_m })))).digest('hex');
  assert.equal(result.metadata.geometrySha256, hash);
  assert.equal(result.metadata.terrain.sourceCRS, 'EPSG:5186');
  assert.equal(result.metadata.terrain.sourceKind, 'local-file');
  assert.equal(result.metadata.terrain.sourceSha256, input.sourceSha256);
  assert.equal(result.metadata.url, input.sourceUrl);
  assert.equal(result.metadata.sourceId, input.id);
  assert.equal(result.metadata.possiblyTruncated, true);
  assert.equal(result.summary.originalCRS, 'EPSG:5186');
  assert.equal(result.summary.metresToDrawingUnits, 1);
  assert.deepEqual(parseGeoReference(metadataText(result.metadata)), result.metadata);
  assert.notEqual(projectTerrain(source([feature('LineString', [a, b], 28)]), { units: 6 }).metadata.geometrySha256, hash);
  assert.equal(projectTerrain(source(undefined, { sourceKind: 'bundled-vworld-contours' }), { units: 4 }).metadata.terrain.sourceKind, 'bundled-vworld-contours');
});

test('preserves downloaded terrain origin and download time through projection and metadata', () => {
  const downloadedAt = '2026-10-21T09:12:00.000Z';
  const input = source(undefined, { sourceKind: 'public-download', sourceUrl: 'https://data.example.org/contours.geojson?edition=2026',
    sourceLabel: '공개 다운로드 원본(원출처·표고 기준 미검증)', downloadedAt });
  const result = projectTerrain(input, { units: 4, georeference: parcel().metadata });
  assert.equal(result.metadata.url, input.sourceUrl);
  assert.equal(result.metadata.retrievedAt, input.retrievedAt);
  assert.equal(result.metadata.terrain.sourceKind, 'public-download');
  assert.equal(result.metadata.terrain.sourceLabel, input.sourceLabel);
  assert.equal(result.metadata.terrain.downloadedAt, downloadedAt);
  assert.equal(result.metadata.terrain.sourceCRS, input.originalCRS);
  assert.equal(result.metadata.terrain.sourceSha256, input.sourceSha256);
  assert.equal(result.metadata.terrain.verticalDatum, 'unknown');
  assert.deepEqual(result.entities, projectTerrain(source(), { units: 4, georeference: parcel().metadata }).entities);
  assert.deepEqual(parseGeoReference(metadataText(result.metadata)), result.metadata);
  for (const override of [{ downloadedAt: undefined }, { downloadedAt: 'invalid' }, { sourceLabel: '공식 검증 완료' }]) {
    assert.throws(() => projectTerrain({ ...input, ...override }, { units: 4 }));
  }
});

test('terrain metadata can anchor later parcel and terrain insertions', () => {
  const first = projectTerrain(source(), { units: 4, x_mm: 2000, y_mm: 3000 });
  const next = projectTerrain(source(undefined, { id: 'terrain-next' }), { units: 4, georeference: first.metadata });
  assert.deepEqual(next.entities, first.entities);
  assert.equal(next.metadata.sourceId, 'terrain-next');
  const parcelSource = source([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[a, b, c, [a[0], c[1]], a]] }, properties: {} }], { sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral' });
  const nextParcel = projectParcels(parcelSource, { units: 4, georeference: first.metadata });
  assert.deepEqual(nextParcel.metadata.insertionMm, first.metadata.insertionMm);
  assert.equal(Object.hasOwn(nextParcel.metadata, 'terrain'), false);
});

test('keeps source immutable and physical geometry identical across mm, metres and inches', () => {
  const input = source();
  const before = JSON.stringify(input);
  const mm = projectTerrain(input, { units: 4 });
  for (const units of [1, 4, 6]) assert.deepEqual(projectTerrain(input, { units }).entities, mm.entities);
  assert.equal(JSON.stringify(input), before);
  const offset = projectTerrain(input, { units: 4, x_mm: 1000, y_mm: -500 });
  offset.entities[0].verticesMm.forEach((point, i) => { close(point[0], mm.entities[0].verticesMm[i][0] + 1000); close(point[1], mm.entities[0].verticesMm[i][1] - 500); });
});

test('records the actual SHP PRJ declaration and inclusive supported elevation limits', () => {
  const originalCRS = 'PROJCS["Korea_2000_Central_Belt_2010",GEOGCS["GCS_Korea_2000"]]';
  const result = projectTerrain(source([feature('Point', a, -500), feature('Point', b, 9000)], { originalCRS }), { units: 4 });
  assert.equal(result.metadata.terrain.sourceCRS, originalCRS);
  assert.equal(result.summary.minElevationM, -500);
  assert.equal(result.summary.maxElevationM, 9000);
  assert.equal(result.summary.contourCount, 0);
  assert.equal(result.summary.spotCount, 2);
});

test('rejects missing or invented heights and unsupported source geometry', () => {
  for (const elevation of [undefined, null, '30', NaN, Infinity, -500.01, 9000.01]) {
    const item = feature(); item.properties.elevation_m = elevation;
    assert.throws(() => projectTerrain(source([item]), { units: 4 }));
  }
  for (const item of [feature('Polygon', [[a, b, c, a]]), { ...feature(), type: 'bad' }, feature('MultiLineString', []), feature('LineString', []), feature('Point', [127, 37, 40]), feature('Point', [0, 0]), feature('Point', [Infinity, 37])]) assert.throws(() => projectTerrain(source([item]), { units: 4 }));
  assert.equal(projectTerrain(source([feature('Point', a, 0)]), { units: 4 }).entities[0].elevationM, 0);
});

test('rejects duplicate or degenerate lines instead of fabricating geometry', () => {
  for (const coordinates of [[a], [a, a], [a, a, b], [a, b, a], [a, b, b, c], [[124, 32], b]]) assert.throws(() => projectTerrain(source([feature('LineString', coordinates)]), { units: 4 }));
});

test('checks source provenance, bbox area and output bounds', () => {
  for (const override of [{ verticalDatum: 'guessed' }, { originalCRS: '' }, { originalCRS: 'PROJCS[' + 'x'.repeat(4096) }, { sourceSha256: 'bad' }, { sourceKind: 'invented' }, { crs: 'EPSG:3857' }, { sourceUrl: 'https://evil.example/data' }, { sourceUrl: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30185&key=private' }, { bbox: [126.9, 37.5, 127, 37.6] }, { count: 2 }]) assert.throws(() => projectTerrain(source(undefined, override), { units: 4 }));
  for (const options of [{ units: 0 }, { x_mm: Infinity }, { x_mm: 100_000_000 }]) assert.throws(() => projectTerrain(source(), { units: 4, ...options }));
  assert.throws(() => projectTerrain(source([feature('Point', [126.9779, 37.567])]), { units: 4 }));
});

test('bounds feature, part and vertex budgets', () => {
  assert.throws(() => projectTerrain(source([]), { units: 4 }));
  assert.throws(() => projectTerrain(source(Array.from({ length: 101 }, () => feature())), { units: 4 }));
  assert.throws(() => projectTerrain(source([feature('MultiLineString', Array.from({ length: 501 }, () => [a, b]))]), { units: 4 }));
  const many = Array.from({ length: 20_001 }, (_, i) => [126.978 + (i % 2) * 0.0001, 37.5665 + i * 1e-9]);
  assert.throws(() => projectTerrain(source([feature('LineString', many)]), { units: 4 }));
});
