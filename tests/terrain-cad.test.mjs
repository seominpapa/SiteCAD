import test from 'node:test';
import assert from 'node:assert/strict';
import { CadEditor } from '../public/cad.js';
import { PROJ_DEFINITION, GEO_LAYER, metadataText } from '../public/geo-reference.js';

function plan(units = 4) {
  const scale = units === 6 ? 1000 : 1;
  const terrain = { sourceKind: 'local-file', sourceCRS: 'EPSG:5179', verticalDatum: 'unknown', sourceSha256: 'b'.repeat(64),
    contourCount: 2, spotCount: 1, minElevationM: -2.5, maxElevationM: 12.75 };
  const metadata = { version: 1, kind: 'terrain', sourceCRS: 'EPSG:4326', targetCRS: 'EPSG:5179', originLonLat: [127, 37],
    originProjectedM: [950000, 1900000], insertionMm: [1000, 2000], units, mmPerUnit: scale, metresToDrawingUnits: 1000 / scale,
    axis: 'E,N', modelScale: 1, projDefinition: PROJ_DEFINITION, projectionLibrary: 'proj4@2.21.0', sourceId: 'geo-terrain-test',
    url: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30185', retrievedAt: '2026-10-22T00:00:00Z',
    geometrySha256: 'a'.repeat(64), featureCount: 3, ringCount: 0, netAreaM2: null, possiblyTruncated: false, terrain };
  return { entities: [{ kind: 'contour', verticesMm: [[0, 0], [2000, 0], [2000, 2000]], elevationM: 12.5, closed: false },
    { kind: 'contour', verticesMm: [[3000, 0], [4000, 0], [4000, 1000]], elevationM: -2.5, closed: true },
    { kind: 'spot', positionMm: [5000, 6000], elevationM: 12.75 }], metadata,
    summary: { featureCount: 3, contourCount: 2, spotCount: 1, minElevationM: -2.5, maxElevationM: 12.75,
      sourceCRS: 'EPSG:4326', targetCRS: 'EPSG:5179', units, mmPerUnit: scale,
      metresToDrawingUnits: 1000 / scale, modelScale: 1, possiblyTruncated: false } };
}
function engine(units = 4) {
  const state = { ok: true, document_id: 1, revision: 1, geometry_revision: 7, layout: 'Model', selection: [] };
  const calls = []; let entities = [];
  const control = { request: async request => {
    calls.push(request);
    if (request.op === 'state') return structuredClone(state);
    if (request.op === 'header') return { ok: true, insertion_units: units };
    if (request.op === 'query') { const found = request.handles ? entities.filter(e => request.handles.includes(e.handle)) : entities;
      return { ok: true, document_id: 1, geometry_revision: state.geometry_revision, count: found.length,
        returned: found.length, next_offset: null, entities: structuredClone(found) }; }
    if (request.op === 'entities_create') {
      entities = request.entities.map((e, i) => ({ ...structuredClone(e), handle: (10 + i).toString(16).toUpperCase(),
        properties: e.type === 'Text' ? { value: e.value, insertion_point: e.position, height: e.height } :
          e.type === 'Point' ? { location: e.location } : { start: e.start, end: e.end } }));
      state.revision++; state.geometry_revision++;
      return { ok: true, result: { created: entities.length, handles: entities.map(e => e.handle) } };
    }
    if (request.op === 'audit') return { ok: true, summary: { errors: 0 }, target: { dropped_on_save: 0 } };
    if (request.op === 'save') return { ok: true, result: { bytes: 7, dropped_on_save: 0, data_base64: btoa('AC1032x') } };
    return { ok: true };
  } };
  return { cad: new CadEditor({ contentWindow: { ocsControl: control } }), state, calls, control,
    setEntities: value => { entities = value; } };
}

test('terrain inserts complete open/closed contours and labeled spots atomically at true elevation in mm and metres', async () => {
  for (const units of [4, 6]) {
    const { cad, calls } = engine(units); const value = plan(units); const scale = value.metadata.mmPerUnit;
    const result = await cad.insertTerrain(value, await cad.context());
    const writes = calls.filter(c => c.op === 'entities_create'); assert.equal(writes.length, 1);
    const entities = writes[0].entities; assert.equal(entities.length, 10);
    assert.deepEqual(entities[0], { type: 'Line', layer: 'VWORLD_CONTOURS', start: [0, 0, 12500 / scale], end: [2000 / scale, 0, 12500 / scale] });
    assert.deepEqual(entities[5].end, [3000 / scale, 0, -2500 / scale]);
    assert.deepEqual(entities[7], { type: 'Point', layer: 'VWORLD_ELEVATIONS', location: [5000 / scale, 6000 / scale, 12750 / scale] });
    assert.equal(entities[8].value, '12.75m'); assert.equal(entities[8].height, 1000 / scale);
    assert.equal(entities[9].layer, GEO_LAYER); assert.equal(entities[9].value, metadataText(value.metadata));
    assert.equal(result.handles.length, 9); assert.deepEqual(cad.lastHandles, result.handles);
    assert.match(result.details.join(' '), /수직|표고/);
    assert.deepEqual((await cad.save('terrain.dwg')).georeferences, [value.metadata]);
  }
});

test('terrain validation rejects invalid coordinates, heights, counts, duplicates, metadata and summaries before writing', async () => {
  const { cad, calls } = engine(); const base = await cad.context(); const value = plan();
  const first = value.entities[0];
  const invalid = [null, { ...value, metadata: null }, { ...value, entities: [] },
    { ...value, entities: Array.from({ length: 501 }, () => first) },
    { ...value, entities: [{ ...first, verticesMm: [[0, 0], [0, 0]] }] },
    { ...value, entities: [{ ...first, verticesMm: [[0, 0], [Infinity, 0]] }] },
    { ...value, entities: [{ ...first, verticesMm: [[0, 0], [1e9, 0]] }] },
    { ...value, entities: [{ ...first, verticesMm: [[0, 0], [1, 0]], closed: true }] },
    { ...value, entities: [{ ...first, verticesMm: Array.from({ length: 20001 }, (_, i) => [i, i]) }] },
    { ...value, entities: [{ ...first, elevationM: NaN }] },
    { ...value, entities: [{ ...first, elevationM: 10001 }] },
    { ...value, entities: [{ kind: 'spot', positionMm: [0], elevationM: 5 }] },
    { ...value, entities: [{ ...first, kind: 'invented' }] },
    { ...value, summary: { ...value.summary, contourCount: 3 } },
    { ...value, summary: { ...value.summary, minElevationM: 0 } },
    { ...value, summary: { ...value.summary, units: 6 } }];
  for (const item of invalid) await assert.rejects(cad.insertTerrain(item, base));
  assert.equal(calls.some(c => c.op === 'entities_create'), false);
});

test('terrain shares parcel anchor guards and prevents stale selection, paper space, command or cancellation writes', async () => {
  const { cad, calls, state, setEntities } = engine(); const base = await cad.context();
  state.selection = ['F']; await assert.rejects(cad.insertTerrain(plan(), base), /변경/); state.selection = [];
  state.layout = 'Layout1'; await assert.rejects(cad.insertTerrain(plan(), base), /모델/); state.layout = 'Model';
  state.command = 'LINE'; await assert.rejects(cad.insertTerrain(plan(), base)); state.command = null;
  const abort = new AbortController(); abort.abort(); await assert.rejects(cad.insertTerrain(plan(), base, { signal: abort.signal }), /취소/);
  const conflicting = { ...plan().metadata, insertionMm: [0, 0] };
  setEntities([{ handle: 'F', type: 'Text', layer: GEO_LAYER, value: metadataText(conflicting) }]);
  await assert.rejects(cad.insertTerrain(plan(), base), /기준/);
  assert.equal(calls.some(c => c.op === 'entities_create'), false);
});

test('terrain verifies all generated XYZ and metadata and exposes uncertain writes without undo', async () => {
  for (const mode of ['start', 'end', 'point', 'label', 'height', 'metadata', 'type', 'layer', 'count', 'handles', 'empty', 'changed', 'cancel']) {
    const { cad, control, calls, state } = engine(); const base = await cad.context(); const original = control.request; const abort = new AbortController();
    control.request = async request => { const reply = await original(request);
      if (request.op === 'entities_create') {
        if (mode === 'count') reply.result.created--;
        if (mode === 'handles') reply.result.handles[1] = reply.result.handles[0];
        if (mode === 'cancel') abort.abort();
      }
      if (request.op === 'query' && request.handles) {
        if (mode === 'start') reply.entities[0].properties.start[2] = 0;
        if (mode === 'end') reply.entities[0].properties.end[0]++;
        if (mode === 'point') reply.entities[7].properties.location[2] = 0;
        if (mode === 'label') reply.entities[8].properties.value = '0m';
        if (mode === 'height') reply.entities[8].properties.height = 0;
        if (mode === 'metadata') reply.entities[9].properties.value = '{}';
        if (mode === 'type') reply.entities[0].type = 'Polyline';
        if (mode === 'layer') reply.entities[0].layer = '0';
        if (mode === 'empty') reply.entities = [];
        if (mode === 'changed') state.revision++;
      }
      return reply;
    };
    await assert.rejects(cad.insertTerrain(plan(), base, { signal: abort.signal }), /반영|변경되었/);
    assert.equal(calls.filter(c => c.op === 'entities_create').length, 1);
    assert.equal(calls.some(c => c.op === 'undo'), false);
  }
});

test('large terrain verification reads every generated object beyond the engine page limit', async () => {
  const { cad, calls } = engine(); const initial = plan();
  const value = { ...initial, entities: [{ kind: 'contour', verticesMm: Array.from({ length: 401 }, (_, i) => [i * 100, i % 2 ? 100 : 0]), elevationM: 12.5, closed: false }],
    metadata: { ...initial.metadata, featureCount: 1, terrain: { ...initial.metadata.terrain, contourCount: 1, spotCount: 0, minElevationM: 12.5, maxElevationM: 12.5 } },
    summary: { ...initial.summary, featureCount: 1, contourCount: 1, spotCount: 0, minElevationM: 12.5, maxElevationM: 12.5 } };
  const result = await cad.insertTerrain(value, await cad.context());
  assert.equal(result.handles.length, 401);
  assert.deepEqual(calls.filter(call => call.op === 'query' && call.handles).map(call => call.handles.length), [200, 200, 2]);
});
