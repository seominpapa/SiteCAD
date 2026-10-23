import test from 'node:test';
import assert from 'node:assert/strict';
import { CadEditor } from '../public/cad.js';
import { metadataText, PROJ_DEFINITION, GEO_LAYER } from '../public/geo-reference.js';

function plan(units = 4) {
  const metadata = { version: 1, sourceCRS: 'EPSG:4326', targetCRS: 'EPSG:5179', originLonLat: [127, 37],
    originProjectedM: [950000, 1900000], insertionMm: [1000, 2000], units, mmPerUnit: units === 6 ? 1000 : 1,
    metresToDrawingUnits: units === 6 ? 1 : 1000, axis: 'E,N', modelScale: 1, projDefinition: PROJ_DEFINITION,
    projectionLibrary: 'proj4@2.21.0', sourceId: 'geo-test', url: 'https://www.vworld.kr/dev/test',
    retrievedAt: '2026-10-22T00:00:00Z', geometrySha256: 'a'.repeat(64), featureCount: 1, ringCount: 2,
    netAreaM2: 3, possiblyTruncated: false };
  return { rings: [{ role: 'outer', verticesMm: [[0, 0], [2000, 0], [2000, 2000], [0, 2000]] },
    { role: 'hole', verticesMm: [[500, 500], [1500, 500], [1500, 1500], [500, 1500]] }], metadata,
  summary: { featureCount: 1, ringCount: 2, outerRingCount: 1, holeRingCount: 1, netAreaM2: 3,
    sourceCRS: 'EPSG:4326', targetCRS: 'EPSG:5179', units, mmPerUnit: metadata.mmPerUnit,
    metresToDrawingUnits: metadata.metresToDrawingUnits, modelScale: 1, possiblyTruncated: false } };
}

function engine(units = 4) {
  const state = { ok: true, document_id: 1, revision: 1, geometry_revision: 7, layout: 'Model', selection: [] };
  const calls = []; let entities = []; const controller = new AbortController();
  const control = { request: async request => {
    calls.push(request);
    if (request.op === 'state') return structuredClone(state);
    if (request.op === 'header') return { ok: true, insertion_units: units };
    if (request.op === 'query') { const found = request.handles ? entities.filter(e => request.handles.includes(e.handle)) : entities;
      return { ok: true, document_id: 1, geometry_revision: state.geometry_revision, count: found.length,
        returned: found.length, next_offset: null, entities: structuredClone(found) }; }
    if (request.op === 'entities_create') {
      entities = request.entities.map((e, i) => ({ handle: (10 + i).toString(16).toUpperCase(), type: e.type === 'Text' ? 'Text' : 'Polyline', layer: e.layer,
        properties: e.type === 'Text' ? { value: e.value, insertion_point: { x: e.position[0], y: e.position[1], z: 0 }, height: e.height } :
          { vertices: e.vertices.map(p => ({ location: { x: p[0], y: p[1] }, bulge: 0 })), is_closed: true } }));
      state.revision++; state.geometry_revision += 8;
      return { ok: true, result: { created: entities.length, handles: entities.map(e => e.handle) } };
    }
    if (request.op === 'measure') return { ok: true, measurements: request.handles.map((handle, i) => ({ handle,
      curve: { closed: true, length: (i ? 4000 : 8000) / (units === 6 ? 1000 : 1), area: (i ? 1e6 : 4e6) / (units === 6 ? 1e6 : 1) } })) };
    if (request.op === 'audit') return { ok: true, summary: { errors: 0 }, target: { dropped_on_save: 0 } };
    if (request.op === 'save') return { ok: true, result: { bytes: 7, dropped_on_save: 0, data_base64: btoa('AC1032x') } };
    return { ok: true };
  } };
  const cad = new CadEditor({ contentWindow: { ocsControl: control } });
  return { cad, state, calls, control, controller, setEntities: value => { entities = value; } };
}

test('parcel context rejects stale, paper-space, malformed, inconsistent or wrong-unit anchors', async () => {
  const { cad, state, setEntities } = engine(); const base = await cad.context();
  assert.deepEqual(await cad.parcelContext(base), { georeference: null, context: base });
  await assert.rejects(cad.parcelContext({ ...base, revision: 0 }), /변경/);
  state.layout = 'Layout1'; await assert.rejects(cad.parcelContext(base), /모델/); state.layout = 'Model';
  const marker = (value, handle = 'A') => ({ handle, type: 'Text', layer: GEO_LAYER, properties: { value } });
  for (const value of [null, '', 'unknown', 'SITECAD_GEOREF_V1:{broken']) {
    setEntities([marker(value)]); await assert.rejects(cad.parcelContext(base), /기준|손상/);
  }
  const metadata = plan().metadata;
  setEntities([marker(metadataText(metadata)), marker(metadataText({ ...metadata, sourceId: 'second' }), 'B')]);
  assert.deepEqual((await cad.parcelContext(base)).georeference, metadata);
  setEntities([marker(metadataText(metadata)), marker(metadataText({ ...metadata, insertionMm: [0, 0] }), 'B')]);
  await assert.rejects(cad.parcelContext(base), /기준/);
  setEntities([marker(metadataText(plan(6).metadata))]); await assert.rejects(cad.parcelContext(base), /단위/);
});

test('single atomic creation preserves outer/hole geometry, model scale and metadata in mm and metre drawings', async () => {
  for (const units of [4, 6]) {
    const { cad, calls } = engine(units); const base = await cad.context();
    const result = await cad.insertParcels(plan(units), base);
    const writes = calls.filter(c => c.op === 'entities_create'); assert.equal(writes.length, 1);
    assert.equal(writes[0].entities.length, 3);
    assert.deepEqual(writes[0].entities[0].vertices[2], units === 4 ? [2000, 2000, 0] : [2, 2, 0]);
    assert.equal(writes[0].entities[0].closed, true); assert.equal(writes[0].entities[1].layer, 'VWORLD_HOLES');
    assert.equal(writes[0].entities[2].value, metadataText(plan(units).metadata));
    assert.deepEqual(writes[0].entities[2].position, units === 4 ? [1000, 2000, 0] : [1, 2, 0]);
    assert.deepEqual(cad.lastHandles, ['A', 'B']); assert.deepEqual(result.handles, ['A', 'B']);
    assert.equal(result.summary.netAreaM2, 3); assert.match(result.message, /완료/);
    assert.deepEqual((await cad.save('parcel.dwg')).georeferences, [plan(units).metadata]);
  }
});

test('invalid plans, stale selections, cancellation and anchor conflicts write nothing', async () => {
  const { cad, calls, state, controller, setEntities } = engine(); const base = await cad.context();
  const invalids = [{ ...plan(), summary: { ...plan().summary, netAreaM2: 4 } },
    { ...plan(), rings: [{ role: 'outer', verticesMm: [[0, 0], [Infinity, 0], [0, 1]] }] },
    { ...plan(), rings: [{ role: 'bad', verticesMm: [[0, 0], [1, 0], [0, 1]] }] },
    { ...plan(), rings: [{ role: 'outer', verticesMm: [[0, 0], [0, 0], [0, 1]] }] }];
  for (const value of invalids) await assert.rejects(cad.insertParcels(value, base));
  state.selection = ['F']; await assert.rejects(cad.insertParcels(plan(), base), /변경/); state.selection = [];
  controller.abort(); await assert.rejects(cad.insertParcels(plan(), base, { signal: controller.signal }), /취소/);
  setEntities([{ handle: 'F', type: 'Text', layer: GEO_LAYER, properties: { value: metadataText({ ...plan().metadata, insertionMm: [0, 0] }) } }]);
  await assert.rejects(cad.insertParcels(plan(), base), /기준/);
  assert.equal(calls.some(c => c.op === 'entities_create'), false);
});

test('post-commit cancellation and failed verification report applied state without automatic undo', async () => {
  for (const mode of ['cancel', 'shape', 'measure', 'count']) {
    const { cad, calls, control, controller } = engine(); const base = await cad.context(); const original = control.request;
    control.request = async request => { const reply = await original(request);
      if (request.op === 'entities_create' && mode === 'cancel') controller.abort();
      if (request.op === 'entities_create' && mode === 'count') reply.result.created = 1;
      if (request.op === 'query' && request.handles && mode === 'shape') reply.entities[0].properties.vertices[0].location.x += 1;
      if (request.op === 'measure' && mode === 'measure') reply.measurements[0].curve.area = 0;
      return reply; };
    await assert.rejects(cad.insertParcels(plan(), base, { signal: controller.signal }), /반영|변경되었/);
    assert.equal(calls.filter(c => c.op === 'entities_create').length, 1);
    assert.equal(calls.some(c => c.op === 'undo'), false);
  }
});

test('metadata scanning reads all pages and rejects incomplete, duplicated or changing pages', async () => {
  const { cad, control, state } = engine(); const base = await cad.context(); const original = control.request;
  const ordinary = Array.from({ length: 200 }, (_, i) => ({ handle: (100 + i).toString(16), type: 'Line', layer: '0' }));
  const marker = { handle: 'FFF', type: 'Text', layer: GEO_LAYER, properties: { value: metadataText(plan().metadata) } };
  let mode = 'valid';
  control.request = async request => {
    if (request.op !== 'query') return original(request);
    const rows = [...ordinary, marker]; const offset = request.offset || 0; const limit = request.limit || 200;
    const entities = rows.slice(offset, offset + limit); const next = offset + entities.length;
    const reply = { ok: true, document_id: 1, geometry_revision: 7, count: rows.length, returned: entities.length,
      entities, next_offset: next < rows.length ? next : null };
    if (offset && mode === 'missing') reply.next_offset = 0;
    if (offset && mode === 'duplicate') reply.entities[0] = ordinary[0];
    if (offset && mode === 'revision') reply.geometry_revision = 8;
    if (offset && mode === 'count') reply.count++;
    if (offset && mode === 'returned') reply.returned = 0;
    if (offset && mode === 'incomplete') reply.entities = [];
    if (offset && mode === 'state') state.selection = ['E'];
    return reply;
  };
  assert.deepEqual((await cad.parcelContext(base)).georeference, plan().metadata);
  for (mode of ['missing', 'duplicate', 'revision', 'count', 'returned', 'incomplete', 'state']) {
    await assert.rejects(cad.parcelContext(base)); state.selection = [];
  }
});

test('bounded browser validation rejects oversized, degenerate and forged parcel plans', async () => {
  const { cad, calls, setEntities } = engine(); const base = await cad.context();
  const initial = plan(); const ring = initial.rings[0];
  const invalids = [null, { ...initial, metadata: null }, { ...initial, rings: [] },
    { ...initial, rings: Array.from({ length: 201 }, () => ring) },
    { ...initial, rings: [{ ...ring, pnu: 'bad' }] },
    { ...initial, rings: [{ ...ring, verticesMm: Array.from({ length: 20001 }, () => [0, 0]) }] },
    { ...initial, rings: [{ ...ring, verticesMm: [[0, 0], [1, 1], [2, 2]] }] },
    { ...initial, rings: [{ ...ring, verticesMm: [[0, 0], [1e9, 0], [0, 1]] }] },
    { ...initial, summary: null }];
  for (const value of invalids) await assert.rejects(cad.insertParcels(value, base));
  setEntities([{ handle: 'A', type: 'Line', layer: GEO_LAYER }]);
  await assert.rejects(cad.insertParcels(initial, base), /손상/);
  assert.equal(calls.some(c => c.op === 'entities_create'), false);
});

test('post-create shape, metadata, handle and measurement failures remain explicit', async () => {
  for (const mode of ['open', 'bulge', 'layer', 'type', 'height', 'position', 'text', 'handle', 'empty', 'measureMissing', 'measureOpen', 'changed']) {
    const { cad, calls, control, state } = engine(); const base = await cad.context(); const original = control.request;
    control.request = async request => { const reply = await original(request);
      if (request.op === 'query' && request.handles) {
        const shape = reply.entities[0]; const text = reply.entities.at(-1);
        if (mode === 'open') shape.properties.is_closed = false;
        if (mode === 'bulge') shape.properties.vertices[0].bulge = 1;
        if (mode === 'layer') shape.layer = 'wrong';
        if (mode === 'type') shape.type = 'Line';
        if (mode === 'height') text.properties.height *= 2;
        if (mode === 'position') text.properties.insertion_point.x++;
        if (mode === 'text') text.properties.value = 'bad';
        if (mode === 'handle') shape.handle = text.handle;
        if (mode === 'empty') reply.entities = [];
      }
      if (request.op === 'measure') {
        if (mode === 'measureMissing') reply.measurements = [];
        if (mode === 'measureOpen') reply.measurements[0].curve.closed = false;
        if (mode === 'changed') state.revision++;
      }
      return reply; };
    await assert.rejects(cad.insertParcels(plan(), base), /반영|변경되었/);
    assert.equal(calls.some(c => c.op === 'undo'), false);
  }
});

test('cancellation or a changed selection during the final mutation guard prevents the write', async () => {
  for (const mode of ['cancel', 'selection', 'layout']) {
    const { cad, calls, control, controller } = engine(); const base = await cad.context();
    const originalMutate = cad.mutate.bind(cad); const originalRequest = control.request;
    cad.mutate = async (...args) => {
      control.request = async request => { const reply = await originalRequest(request);
        if (request.op === 'state') {
          if (mode === 'cancel') controller.abort();
          if (mode === 'selection') reply.selection = ['E'];
          if (mode === 'layout') reply.layout = 'Layout1';
        }
        return reply; };
      return originalMutate(...args);
    };
    await assert.rejects(cad.insertParcels(plan(), base, { signal: controller.signal }), /취소|변경/);
    assert.equal(calls.some(c => c.op === 'entities_create'), false);
  }
});
