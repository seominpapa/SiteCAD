import test from 'node:test';
import assert from 'node:assert/strict';
import { projectParcels } from '../lib/parcel-projection.mjs';
import { metadataText, parseGeoReference } from '../public/geo-reference.js';

const source = { type: 'FeatureCollection', crs: 'EPSG:4326', bbox: [126.98, 37.55, 126.981, 37.551],
  id: 'geo-first', sourceUrl: 'https://www.vworld.kr/dev/test', retrievedAt: '2026-10-22T00:00:00Z', possiblyTruncated: false,
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[126.98, 37.55], [126.981, 37.55], [126.981, 37.551], [126.98, 37.55]]] } }] };
const terrain = () => ({ ...projectParcels(source, { units: 4 }).metadata, kind: 'terrain',
  url: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30185', ringCount: 0, netAreaM2: null,
  terrain: { sourceCRS: 'EPSG:5179', verticalDatum: 'unknown', sourceSha256: 'b'.repeat(64), sourceKind: 'local-file', contourCount: 1, spotCount: 0, minElevationM: 30, maxElevationM: 30 } });

test('terrain metadata retains source heights without pretending to have parcel area', () => {
  const value = terrain();
  assert.deepEqual(parseGeoReference(metadataText(value)), value);
  const copy = parseGeoReference(value); copy.terrain.spotCount++;
  assert.equal(value.terrain.spotCount, 0);
  for (const change of [{ kind: 'other' }, { netAreaM2: 1 }, { ringCount: 1 }, { terrain: { ...value.terrain, sourceSha256: '' } },
    { terrain: { ...value.terrain, minElevationM: NaN } }, { terrain: { ...value.terrain, spotCount: -1 } },
    { terrain: { ...value.terrain, minElevationM: 31 } }, { terrain: { ...value.terrain, extra: true } },
    { url: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?key=secret' }]) assert.throws(() => parseGeoReference({ ...value, ...change }));
});

test('subsequent parcels reuse a terrain anchor while keeping parcel metadata semantics', () => {
  const anchor = terrain(); const next = projectParcels(source, { units: 4, georeference: anchor });
  assert.deepEqual(next.metadata.originProjectedM, anchor.originProjectedM);
  assert.equal(next.metadata.kind, undefined); assert.equal(next.metadata.terrain, undefined);
  assert(next.metadata.netAreaM2 > 0);
});

const downloadedTerrain = () => {
  const value = terrain();
  return { ...value, url: 'https://data.example.org/contours.geojson?edition=2026', terrain: { ...value.terrain,
    sourceKind: 'public-download', sourceLabel: '공개 다운로드 원본(원출처·표고 기준 미검증)', downloadedAt: '2026-10-21T10:00:00.000Z' } };
};

test('round-trips public download provenance while preserving strict parcel and legacy source restrictions', () => {
  const value = downloadedTerrain();
  assert.deepEqual(parseGeoReference(metadataText(value)), value);
  const parcelMetadata = projectParcels(source, { units: 4 }).metadata;
  assert.throws(() => parseGeoReference({ ...parcelMetadata, url: value.url }));
  assert.throws(() => parseGeoReference({ ...terrain(), url: value.url }));
  assert.throws(() => parseGeoReference({ ...terrain(), terrain: { ...terrain().terrain, ...value.terrain, sourceKind: 'bundled-vworld-contours' } }));
  assert.deepEqual(projectParcels(source, { units: 4, georeference: value }).metadata.originProjectedM, value.originProjectedM);
  for (const change of [{ downloadedAt: undefined }, { downloadedAt: 'invalid' }, { downloadedAt: 'x'.repeat(41) },
    { sourceLabel: '공식 자료' }, { sourceLabel: undefined }, { extra: true }]) {
    assert.throws(() => parseGeoReference({ ...value, terrain: { ...value.terrain, ...change } }));
  }
});

test('rejects private, credentialed and non-HTTPS public-download metadata addresses', () => {
  const value = downloadedTerrain();
  for (const url of ['http://data.example.org/terrain.geojson', 'https://user:password@data.example.org/terrain.geojson',
    'https://127.0.0.1/terrain.geojson', 'https://10.1.2.3/terrain.geojson', 'https://0x7f000001/terrain.geojson',
    'https://[::1]/terrain.geojson', 'https://192.168.0.1/terrain.geojson', 'https://localhost/terrain.geojson',
    'https://files.local/terrain.geojson', 'https://data.home/terrain.geojson', 'https://files.internal/terrain.geojson',
    'https://data.example.org:8443/terrain.geojson', 'https://data.example.org/terrain.geojson#private',
    'https://data.example.org/terrain.geojson?token=private', 'https://data.example.org/terrain.geojson?%6Bey=private',
    'https://data.example.org/terrain.geojson?signature=private', 'https://data.example.org/terrain.geojson?session=private',
    'https://data.example.org/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature/terrain.geojson',
    'https://data.example.org/' + 'a'.repeat(2048)]) {
    assert.throws(() => parseGeoReference({ ...value, url }), url);
  }
});
