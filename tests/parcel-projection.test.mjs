import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectParcels } from '../lib/parcel-projection.mjs';
import { GEO_LAYER, OUTER_LAYER, HOLE_LAYER, METADATA_PREFIX, parseGeoReference, metadataText } from '../public/geo-reference.js';
import { mmPerUnit } from '../public/units.js';

const outer = [[126.978, 37.5665], [126.979, 37.5665], [126.979, 37.5675], [126.978, 37.5675], [126.978, 37.5665]];
const hole = [[126.9782, 37.5667], [126.9784, 37.5667], [126.9784, 37.5669], [126.9782, 37.5669], [126.9782, 37.5667]];
const feature = geometry => ({ type: 'Feature', geometry, properties: { pnu: '1111010100100010000', address: '서울특별시 중구' } });
const source = (features = [feature({ type: 'Polygon', coordinates: [outer] })], overrides = {}) => ({
  type: 'FeatureCollection', crs: 'EPSG:4326', bbox: [126.978, 37.5665, 126.979, 37.5675], features, count: features.length,
  id: 'geo-fixture-0001', sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral', retrievedAt: '2026-10-22T00:00:00.000Z', possiblyTruncated: false, ...overrides,
});
const close = (actual, expected, tolerance = 0.002) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('matches independent pyproj3.8 EPSG:4326→5179 reference points and Shapely area', () => {
  const projected = [[953901.1653121515, 1952032.0809790879], [953989.4778875523, 1952031.5908961713], [953990.0929842938, 1952142.535988877], [953901.7815895921, 1952143.026076362]];
  const origin = [953945.6294420916, 1952087.3083653094];
  const result = projectParcels(source(), { units: 4 });
  assert.deepEqual(result.metadata.originLonLat, [126.9785, 37.567]);
  result.metadata.originProjectedM.forEach((value, i) => close(value, origin[i], 0.000002));
  result.rings[0].verticesMm.forEach((point, i) => point.forEach((value, axis) => close(value, (projected[i][axis] - origin[axis]) * 1000)));
  close(result.metadata.netAreaM2, 9798.083309395677, 0.00001);
  assert.equal(result.rings[0].verticesMm.length, 4);
  assert.equal(result.rings[0].role, 'outer');
  assert.equal(result.rings[0].pnu, '1111010100100010000');
});

test('preserves physical scale across millimetre, metre and imperial drawing units', () => {
  const mm = projectParcels(source(), { units: 4 });
  for (const units of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21]) {
    const result = projectParcels(source(), { units });
    assert.deepEqual(result.rings, mm.rings);
    assert.equal(result.metadata.mmPerUnit, mmPerUnit(units));
    assert.equal(result.metadata.metresToDrawingUnits, 1000 / mmPerUnit(units));
    assert.equal(result.metadata.modelScale, 1);
  }
});

test('retains holes and every MultiPolygon outer ring while subtracting hole areas', () => {
  const outerOnly = projectParcels(source(), { units: 4 });
  const holeOnly = projectParcels(source([feature({ type: 'Polygon', coordinates: [hole] })]), { units: 4 });
  const result = projectParcels(source([feature({ type: 'MultiPolygon', coordinates: [[outer, hole], [outer]] })]), { units: 4 });
  assert.deepEqual(result.rings.map(ring => ring.role), ['outer', 'hole', 'outer']);
  close(result.metadata.netAreaM2, 2 * outerOnly.metadata.netAreaM2 - holeOnly.metadata.netAreaM2, 0.00001);
  assert.equal(result.metadata.featureCount, 1);
  assert.equal(result.metadata.ringCount, 3);
  assert.equal(result.summary.holeRingCount, 1);
  assert.equal(result.summary.outerRingCount, 2);
});

test('reuses the first georeference anchor and offset for a different query bbox', () => {
  const first = projectParcels(source(), { units: 4, x_mm: 1250, y_mm: -500 });
  const shifted = source(undefined, { bbox: [126.98, 37.5665, 126.981, 37.5675], id: 'geo-fixture-next' });
  const next = projectParcels(shifted, { units: 4, georeference: first.metadata });
  assert.deepEqual(next.metadata.originLonLat, first.metadata.originLonLat);
  assert.deepEqual(next.metadata.originProjectedM, first.metadata.originProjectedM);
  assert.deepEqual(next.metadata.insertionMm, [1250, -500]);
  assert.deepEqual(next.rings, first.rings);
  assert.equal(next.metadata.sourceId, 'geo-fixture-next');
  assert.deepEqual(projectParcels(shifted, { units: 4, georeference: first.metadata, x_mm: 1250, y_mm: -500 }).rings, first.rings);
  for (const options of [{ x_mm: 0 }, { y_mm: 0 }, { units: 6 }]) assert.throws(() => projectParcels(shifted, { units: 4, georeference: first.metadata, ...options }));
});

test('adds offsets in millimetres and never changes source objects', () => {
  const input = source();
  const before = JSON.stringify(input);
  const origin = projectParcels(input, { units: 4 });
  const moved = projectParcels(input, { units: 6, x_mm: 1000, y_mm: 2000 });
  moved.rings[0].verticesMm.forEach((point, i) => { close(point[0], origin.rings[0].verticesMm[i][0] + 1000); close(point[1], origin.rings[0].verticesMm[i][1] + 2000); });
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(moved.rings[0].verticesMm[0], outer[0]);
});

test('hashes only original geometry and records reproducible source provenance', () => {
  const input = source(undefined, { possiblyTruncated: true });
  const result = projectParcels(input, { units: 4 });
  assert.equal(result.metadata.geometrySha256, createHash('sha256').update(JSON.stringify(input.features.map(value => value.geometry))).digest('hex'));
  assert.equal(result.metadata.sourceId, input.id);
  assert.equal(result.metadata.url, input.sourceUrl);
  assert.equal(result.metadata.retrievedAt, input.retrievedAt);
  assert.equal(result.metadata.possiblyTruncated, true);
  assert.equal(result.metadata.sourceCRS, 'EPSG:4326');
  assert.equal(result.metadata.targetCRS, 'EPSG:5179');
  assert.equal(result.metadata.axis, 'E,N');
  assert.equal(result.metadata.projectionLibrary, 'proj4@2.21.0');
  assert.match(result.metadata.projDefinition, /\+ellps=GRS80/);
});

test('metadata text round-trips through strict bounded validation and named layers', () => {
  const metadata = projectParcels(source(), { units: 4 }).metadata;
  assert.equal(GEO_LAYER, 'SITECAD_GEOREF'); assert.equal(OUTER_LAYER, 'VWORLD_PARCELS'); assert.equal(HOLE_LAYER, 'VWORLD_HOLES');
  assert.equal(METADATA_PREFIX, 'SITECAD_GEOREF_V1:');
  assert.deepEqual(parseGeoReference(metadataText(metadata)), metadata);
  assert.deepEqual(parseGeoReference(metadata), metadata);
  assert.equal(parseGeoReference(null), null);
  assert.equal(parseGeoReference(undefined), null);
  assert.equal(parseGeoReference('ordinary CAD note'), null);
  assert.throws(() => parseGeoReference(METADATA_PREFIX + '{bad'));
  assert.throws(() => parseGeoReference(METADATA_PREFIX + ' '.repeat(16_384)));
});

test('metadata validation rejects tampered scales, axes, definition, credentials and unknown fields', () => {
  const metadata = projectParcels(source(), { units: 4 }).metadata;
  for (const override of [{ version: 2 }, { sourceCRS: 'EPSG:3857' }, { targetCRS: 'EPSG:3857' }, { axis: 'N,E' }, { modelScale: 1000 }, { units: 0 }, { mmPerUnit: 1000 }, { metresToDrawingUnits: 1 }, { projDefinition: '+proj=longlat' }, { projectionLibrary: 'another' }, { originLonLat: [0, 0] }, { originProjectedM: [Infinity, 0] }, { insertionMm: [1e9, 0] }, { featureCount: 0 }, { ringCount: 201 }, { netAreaM2: -1 }, { geometrySha256: 'bad' }, { url: 'https://api.vworld.kr/req/data?key=secret' }, { retrievedAt: 'invalid' }, { unexpected: true }]) assert.throws(() => parseGeoReference({ ...metadata, ...override }));
  assert.throws(() => parseGeoReference({ ...metadata, sourceId: 'a'.repeat(20_000) }));
});

test('projection verifies stored anchor against its geographic origin', () => {
  const metadata = projectParcels(source(), { units: 4 }).metadata;
  assert.throws(() => projectParcels(source(), { units: 4, georeference: { ...metadata, originProjectedM: [metadata.originProjectedM[0] + 1, metadata.originProjectedM[1]] } }), /기준/);
});

test('rejects invalid source CRS, unsupported units, coordinates and malformed rings', () => {
  for (const units of [0, 17, null, '4']) assert.throws(() => projectParcels(source(), { units }));
  for (const overrides of [{ crs: 'EPSG:3857' }, { bbox: [127, 37, 126, 38] }, { bbox: [0, 0, 1, 1] }, { id: '' }, { count: 2 }, { sourceUrl: 'file:///private' }]) assert.throws(() => projectParcels(source(undefined, overrides), { units: 4 }));
  for (const coordinates of [[], [[[127, 37], [127.1, 37], [127, 37]]], [[[127, 37], [127.1, 37], [127.1, 37.1], [127, 37.1]]], [[[127, 37], [127, 37], [127.1, 37.1], [127, 37]]], [[[127, 37], [127.1, 37.1], [127.2, 37.2], [127, 37]]], [[[127, 37], [NaN, 37], [127, 37.1], [127, 37]]], [[[0, 0], [1, 0], [1, 1], [0, 0]]]]) assert.throws(() => projectParcels(source([feature({ type: 'Polygon', coordinates })]), { units: 4 }));
  assert.throws(() => projectParcels(source([feature({ type: 'Point', coordinates: [127, 37] })]), { units: 4 }));
});

test('enforces feature, ring, vertex and resulting local coordinate budgets', () => {
  assert.throws(() => projectParcels(source([]), { units: 4 }));
  assert.throws(() => projectParcels(source(Array.from({ length: 101 }, () => feature({ type: 'Polygon', coordinates: [outer] }))), { units: 4 }));
  assert.throws(() => projectParcels(source([feature({ type: 'MultiPolygon', coordinates: Array.from({ length: 201 }, () => [outer]) })]), { units: 4 }));
  const large = Array.from({ length: 20_001 }, (_, i) => [126.978 + Math.cos(i) / 1000, 37.567 + Math.sin(i) / 1000]);
  assert.throws(() => projectParcels(source([feature({ type: 'Polygon', coordinates: [[...large, large[0]]] })]), { units: 4 }));
  for (const options of [{ x_mm: 100_000_000 }, { y_mm: -100_000_000 }, { x_mm: Infinity }, { y_mm: '0' }]) assert.throws(() => projectParcels(source(), { units: 4, ...options }));
});
