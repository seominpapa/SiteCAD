import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQuantities } from '../public/quantities.js';

const entity = (handle, layer = 'drawing', owner = 31) => ({ handle, layer,
  properties: { common: { owner_handle: owner } } });
const curve = (handle, length, area = null, closed = area !== null) => ({ handle,
  curve: { bounded: length !== null, closed, length, area } });

function engine(entities, measurements, change = {}) {
  const calls = [];
  const records = [{ handle: '1F', name: '*Model_Space', properties: { entity_handles: [] } },
    { handle: '2A', name: '*Paper_Space', properties: { entity_handles: [] } },
    { handle: '40', name: 'BLOCK', properties: { entity_handles: [90] } }];
  const request = async req => {
    calls.push(req);
    const base = { ok: true, document_id: 2, geometry_revision: 7 };
    if (req.op === 'measure') return change.measure?.(req, base) || { ...base,
      measurements: req.handles.map(handle => measurements.find(item => item.handle === handle)) };
    const field = req.op === 'records' ? 'records' : 'entities';
    const all = field === 'records' ? records : entities;
    const values = all.slice(req.offset, req.offset + req.limit);
    const result = { ...base, [field]: values, count: all.length, returned: values.length,
      next_offset: req.offset + values.length < all.length ? req.offset + values.length : null };
    return change.page?.(req, result) || result;
  };
  return { request, calls };
}

test('mm aggregates layers, counts unsupported objects and excludes open area, paper and block definitions', async () => {
  const entities = [entity('A'), entity('B'), entity('C', '__proto__'), entity('D', 'notes'),
    entity('E', 'paper', 42), entity('5A', 'block', 64)];
  const measurements = [curve('A', 20_000, 24_000_000), curve('B', 5_000, 999, false),
    curve('C', 2_000), { handle: 'D', curve: null }];
  const original = structuredClone(entities);
  const { request } = engine(entities, measurements);
  const result = await collectQuantities(request, 1);
  assert.equal(result.totals.count, 4);
  assert.equal(result.totals.lengthM, 27);
  assert.equal(result.totals.areaM2, 24);
  assert.equal(result.totals.lengthCount, 3);
  assert.equal(result.totals.areaCount, 1);
  assert.equal(result.totals.unmeasuredCount, 1);
  assert.equal(result.rows.find(row => row.layer === 'notes').lengthM, null);
  assert.equal(result.rows.find(row => row.layer === '__proto__').count, 1);
  assert.deepEqual(entities, original);
  assert.match(result.scope, /모형 공간/);
});

test('metre drawings, nested dimension ownership and unowned new entities are counted', async () => {
  const dimension = { handle: 'B', layer: 'dims', properties: { Linear: { base: { common: { owner_handle: 31 } } } } };
  const { request } = engine([entity('A'), dimension, entity('C', 'new', 0)],
    [curve('A', 20, 24), { handle: 'B', curve: null }, curve('C', 3)]);
  const report = await collectQuantities(request, 1000);
  assert.equal(report.totals.count, 3);
  assert.equal(report.totals.lengthM, 23);
  assert.equal(report.totals.areaM2, 24);
});

test('VWorld outer and hole boundaries retain counts and lengths without adding either area to quantities', async () => {
  const { request, calls } = engine([
    entity('A', 'drawing'), entity('B', 'VWORLD_PARCELS'), entity('C', 'VWORLD_HOLES'),
    entity('D', 'SITECAD_GEOREF'),
  ], [curve('A', 40, 100), curve('B', 36, 80), curve('C', 20, 20), { handle: 'D', curve: null }]);
  const report = await collectQuantities(request, 1000);
  assert.equal(report.totals.count, 3);
  assert.equal(report.totals.lengthM, 96);
  assert.equal(report.totals.areaM2, 100);
  assert.equal(report.totals.areaCount, 1);
  for (const layer of ['VWORLD_PARCELS', 'VWORLD_HOLES']) {
    const row = report.rows.find(item => item.layer === layer);
    assert.equal(row.count, 1);
    assert.equal(row.lengthCount, 1);
    assert.equal(row.areaM2, null);
    assert.equal(row.areaCount, 0);
  }
  assert.ok(!report.rows.some(row => row.layer === 'SITECAD_GEOREF'));
  assert.ok(!calls.some(call => call.op === 'measure' && call.handles.includes('D')));
  assert.match(report.scope, /VWorld 경계 면적 제외.*삽입 결과 순면적 참고.*경계 길이는 자재 물량 아님/);
});

test('case-insensitive VWorld layer names never produce an available area total', async () => {
  const { request } = engine([entity('A', 'vworld_parcels'), entity('B', 'vworld_holes')],
    [curve('A', 20_000, 24_000_000), curve('B', 4_000, 1_000_000)]);
  const report = await collectQuantities(request, 1);
  assert.equal(report.totals.count, 2);
  assert.equal(report.totals.lengthM, 24);
  assert.equal(report.totals.areaM2, null);
  assert.equal(report.totals.areaCount, 0);
});

test('a model containing only georeference metadata has no quantity rows or measurement requests', async () => {
  const { request, calls } = engine([entity('A', 'sitecad_georef')], []);
  const report = await collectQuantities(request, 1);
  assert.deepEqual(report.rows, []);
  assert.equal(report.totals.count, 0);
  assert.equal(report.totals.areaM2, null);
  assert.ok(!calls.some(call => call.op === 'measure'));
});

test('terrain labels are excluded and closed contours never become construction areas', async () => {
  const { request, calls } = engine([entity('A', 'VWORLD_CONTOURS'), entity('B', 'VWORLD_TERRAIN_LABELS'), entity('C', 'VWORLD_ELEVATIONS')], [curve('A', 1000, 1000000), curve('B', 0), { handle: 'C', curve: null }]);
  const report = await collectQuantities(request, 1);
  assert.equal(report.totals.count, 2); assert.equal(report.totals.areaM2, null);
  assert.ok(!calls.some(call => call.op === 'measure' && call.handles.includes('B')));
  assert.match(report.scope, /지형.*물량 아님/);
});

test('all query pages and measurement batches are included beyond the chat context limit', async () => {
  const entities = Array.from({ length: 450 }, (_, i) => entity((1000 + i).toString(16).toUpperCase()));
  const { request, calls } = engine(entities, entities.map(e => curve(e.handle, 2)));
  const report = await collectQuantities(request, 1000);
  assert.equal(report.totals.count, 450);
  assert.equal(report.totals.lengthM, 900);
  assert.ok(calls.filter(c => c.op === 'query').length > 1);
  assert.ok(calls.filter(c => c.op === 'measure').length > 1);
});

test('empty model returns zero count and unavailable measures without calling measure', async () => {
  const { request, calls } = engine([], []);
  const report = await collectQuantities(request, 1);
  assert.deepEqual(report.rows, []);
  assert.equal(report.totals.count, 0);
  assert.equal(report.totals.lengthM, null);
  assert.equal(report.totals.areaM2, null);
  assert.ok(!calls.some(c => c.op === 'measure'));
});

test('invalid units are rejected before querying', async () => {
  for (const scale of [0, -1, NaN, Infinity, undefined]) {
    await assert.rejects(collectQuantities(() => assert.fail('must not query'), scale), /단위/);
  }
});

test('partial, duplicated, unexpected or non-finite measurements fail the whole report', async () => {
  for (const measurements of [[], [curve('F', 1)], [curve('A', 1), curve('A', 1)],
    [curve('A', NaN)], [curve('A', -2)], [curve('A', 1, Infinity)]]) {
    const { request } = engine([entity('A')], [], { measure: (_, base) => ({ ...base, measurements }) });
    await assert.rejects(collectQuantities(request, 1), /측정/);
  }
});

test('pagination inconsistencies, duplicated handles and geometry changes cannot produce a partial success', async () => {
  for (const patch of [
    { page: (req, result) => req.op === 'query' ? { ...result, next_offset: 0 } : result },
    { page: (req, result) => req.op === 'query' ? { ...result, returned: 0 } : result },
    { page: (req, result) => req.op === 'query' ? { ...result, count: 2 } : result },
    { page: (req, result) => req.op === 'query' ? { ...result, geometry_revision: 8 } : result },
    { measure: (_, base) => ({ ...base, document_id: 3, measurements: [curve('A', 1)] }) }
  ]) {
    const { request } = engine([entity('A')], [curve('A', 1)], patch);
    await assert.rejects(collectQuantities(request, 1));
  }
  const { request } = engine([entity('A'), entity('A')], [curve('A', 1)]);
  await assert.rejects(collectQuantities(request, 1), /중복/);
});

test('unknown owner metadata and missing model space fail clearly', async () => {
  const { request } = engine([{ handle: 'A', layer: 'bad', properties: {} }], []);
  await assert.rejects(collectQuantities(request, 1), /소유/);
  const missing = engine([], [], { page: (req, result) => req.op === 'records'
    ? { ...result, count: 0, returned: 0, next_offset: null, records: [] } : result });
  await assert.rejects(collectQuantities(missing.request, 1), /모형 공간/);
});
