import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { siteRequest, siteArea, publicTerrainSource } from '../lib/site-source.mjs';

const definition = '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs';
const at = (x = 225000, y = 535000, address = '경기도 광주시 경안동 1') => {
  const [longitude, latitude] = proj4(definition, 'EPSG:4326', [x, y]);
  return { crs: 'EPSG:4326', point: { x: longitude, y: latitude }, address };
};

test('site request trims an address and defaults to a 100 metre radius without modifying input', () => {
  const input = Object.freeze({ address: '  경기도 광주시 경안동 1  ' });
  assert.deepEqual(siteRequest(input), { address: '경기도 광주시 경안동 1', radius_m: 100 });
  for (const radius_m of [25, 100, 250]) assert.equal(siteRequest({ address: '가'.repeat(300), radius_m }).radius_m, radius_m);
});

test('site request rejects extra keys, nonplain values and invalid address/radius values', () => {
  const inherited = Object.create({ address: '경기도 광주시' });
  const symbol = { address: '경기도 광주시', [Symbol('extra')]: true };
  for (const input of [undefined, null, [], new Date(), inherited, Object.assign(Object.create(null), { address: 'a' }), {}, { address: 1 }, { address: '' }, { address: '  ' }, { address: '가'.repeat(301) }, { address: '주소\n' }, { address: '주소\u0085' }, { address: '주소\u202e' }, { address: '주소', url: 'https://evil.test' }, symbol]) assert.throws(() => siteRequest(input), /주소|범위/);
  for (const radius_m of [0, 24, 251, 100.5, '100', NaN, Infinity, null]) assert.throws(() => siteRequest({ address: '주소', radius_m }), /반경/);
});

test('site area is a fresh, centred metre-based Korean bbox capped below 1km²', () => {
  const location = at();
  const first = siteArea(location);
  assert.notEqual(first, siteArea(location));
  for (const radius of [25, 100, 250]) {
    const bbox = siteArea(location, radius);
    assert.equal((bbox[0] + bbox[2]) / 2, location.point.x);
    assert.equal((bbox[1] + bbox[3]) / 2, location.point.y);
    const width = (bbox[2] - bbox[0]) * 111320 * Math.cos(location.point.y * Math.PI / 180);
    const height = (bbox[3] - bbox[1]) * 111320;
    assert.ok(Math.abs(width - radius * 2) < 1e-7);
    assert.ok(Math.abs(height - radius * 2) < 1e-7);
    assert.ok(width * height < 1e6);
  }
});

test('site area rejects wrong CRS, invalid numbers, Korean edges and invalid radii', () => {
  for (const location of [undefined, {}, { ...at(), crs: 'EPSG:5186' }, { ...at(), point: { x: '127', y: 37 } }, { ...at(), point: { x: Infinity, y: 37 } }, { ...at(), point: { x: 127, y: NaN } }, { ...at(), point: { x: 0, y: 0 } }, ...[[124, 37], [132, 37], [127, 32], [127, 39.5]].map(([x, y]) => ({ crs: 'EPSG:4326', point: { x, y } }))]) assert.throws(() => siteArea(location), /좌표|영역/);
  for (const radius of [24, 251, null, '25', NaN]) assert.throws(() => siteArea(at(), radius), /반경/);
});

test('Gyeonggi Gwangju source has a fixed public endpoint and bounded GeoJSON query', () => {
  for (const address of ['경기도 광주시 경안동 1', '경기 광주시 중앙로 1', ' 경기도   광주시 경안동 1 ']) {
    const location = at(225000, 535000, address), bbox = siteArea(location);
    const source = publicTerrainSource(location, bbox);
    assert.equal(source.supported, true);
    assert.equal(source.providerId, 'gwangju-city-contours');
    assert.equal(source.fileName, 'gwangju-public-contours.geojson');
    assert.equal(source.unitAssumption, 'm');
    assert.equal(source.verticalDatum, 'unknown');
    assert.match(source.sourceLabel, /광주시.*미검증/);
    assert.equal(source.catalogUrl, 'https://gis.gjcity.go.kr/arcgis/rest/services/GJUIS/LifeMapDynamic/MapServer/34');
    const url = new URL(source.url);
    assert.equal(url.origin, 'https://gis.gjcity.go.kr');
    assert.equal(url.pathname, '/arcgis/rest/services/GJUIS/LifeMapDynamic/MapServer/34/query');
    for (const [name, value] of Object.entries({ f: 'geojson', geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', where: '1=1', outFields: 'OBJECTID,ELE_ALT,CAA_CDE', returnGeometry: 'true', orderByFields: 'OBJECTID' })) assert.equal(url.searchParams.get(name), value);
    assert.equal(url.searchParams.get('resultRecordCount'), null);
    assert.equal(url.searchParams.get('resultOffset'), null);
    assert.equal(url.searchParams.size, 9);
    assert.ok(!/key|token|credential|password/i.test(source.url));
  }
});

test('source selection never uses another jurisdiction or accepts unresolved address text', () => {
  for (const address of ['광주광역시 동구', '경기도 성남시', '광주시 경안동', '', undefined, 42, '가짜 경기도 광주시', '경기도 광주시민회관']) {
    const location = at(); location.address = address;
    const source = publicTerrainSource(location, siteArea(location));
    assert.equal(source.supported, false);
    assert.match(source.message, /공개 지형/);
    assert.equal(source.url, undefined);
  }
});

test('source extent excludes matching addresses with coordinates outside the published layer extent', () => {
  for (const [x, y] of [[210999, 535000], [240701, 535000], [225000, 516599], [225000, 550701]]) {
    const location = at(x, y);
    assert.equal(publicTerrainSource(location, siteArea(location)).supported, false);
  }
});

test('source query validates bbox limits and address-point alignment', () => {
  const location = at();
  for (const bbox of [undefined, [], [127, 37, 128], ['127', 37, 128, 38], [124, 32, 132, 39.5], [127.5, 37.5, 127.4, 37.6], [0, 0, 1, 1], [127.8, 37.8, 127.801, 37.801]]) assert.throws(() => publicTerrainSource(location, bbox), /영역/);
  assert.throws(() => publicTerrainSource({ ...location, crs: 'EPSG:3857' }, siteArea(location)), /좌표/);
});
