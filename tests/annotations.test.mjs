import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationSize, prepareText, prepareDimension, isCadFontResult } from '../public/annotations.js';
const geometry = (span = 6000, offset = 0) => ({ handle: 'A', type: 'Line', layer: 'AI_DRAFT', properties: { common: { owner_handle: 32 } }, bounds: { min: [offset, offset, 0], max: [offset + span, offset + span / 2, 0] } });
const style = (name = 'Standard', handle = '20', font = 'AppleGothic.ttf') => ({ name, handle, properties: { handle: parseInt(handle, 16), name, font_file: font, big_font_file: '', width_factor: 1, height: 0 } });
const dimension = { handle: 'D', type: 'Dimension', bounds: { min: [0, 0, 0], max: [6000, 0, 0] }, properties: { Linear: { base: { style_name: 'ISO-25', common: { owner_handle: 32 } } } } };
function engine({ entities = [geometry(), dimension], textStyles = [style()], dimStyles = [], pages, failWrite } = {}) {
  let records = { text_styles: structuredClone(textStyles), dim_styles: structuredClone(dimStyles), block_records: [{ name: '*MODEL_SPACE', handle: '20' }] };
  let objects = structuredClone(entities);
  const calls = [];
  const cad = { request: async request => {
    calls.push(request);
    if (request.op === 'state') return { ok: true, document_id: 1 };
    if (request.op === 'records') return { ok: true, records: records[request.collection], next_offset: null };
    if (request.op === 'query') return pages ? pages(request) : { ok: true, entities: objects.filter(e => !request.handles || request.handles.includes(e.handle)), next_offset: null };
    throw Error('unexpected read');
  } };
  const io = { check: async () => {}, write: async request => {
    calls.push(request); if (failWrite) throw Error('write rejected');
    if (request.op === 'run') {
      const [, action, name, font] = request.cmd.split(' ');
      const collection = request.cmd.startsWith('DIMSTYLE') ? 'dim_styles' : 'text_styles';
      if (action === 'NEW') records = { ...records, [collection]: [...records[collection], collection === 'text_styles' ? style(name, '0', 'txt.shx') : { name, handle: '0', properties: { dimtxt: 2.5, dimasz: 2.5, dimgap: 0.625, dimexo: 0.625, dimexe: 1.25, dimdli: 3.75, dimscale: 1, dimlfac: 1, dimtxsty: 'Standard', dimtxsty_handle: 32, dimsah: false, annotative: false } }] };
      if (action === 'FONT') records = { ...records, [collection]: records[collection].map(record => record.name === name ? { ...record, properties: { ...record.properties, font_file: font } } : record) };
    }
    if (request.op === 'set_properties') {
      const patch = record => ({ ...record, properties: request.updates.reduce((properties, update) => ({ ...properties, [update.path.slice(1)]: update.value }), record.properties) });
      if (request.collection === 'entities') objects = objects.map(e => e.handle === request.handle ? { ...e, properties: { Linear: { base: { ...e.properties.Linear.base, style_name: request.updates[0].value } } } } : e);
      else records = { ...records, [request.collection]: records[request.collection].map(record => record.name === request.name ? patch(record) : record) };
    }
    return { ok: true };
  } };
  return { cad, io, calls, records: () => records, entities: () => objects, setEntities: value => { objects = structuredClone(value); } };
}
const mockFont = t => t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 1, 0, 0])));

test('font render invalidation accepts only the requested known font family and a single face', () => {
  const request = { file_name: 'malgun.ttf' };
  const result = { file_name: 'malgun.ttf', family: 'Malgun Gothic', faces: 1 };
  assert.equal(isCadFontResult(request, result), true);
  for (const invalid of [{ ...result, faces: 2 }, { ...result, file_name: 'AppleGothic.ttf' }, { ...result, family: 'Custom' }, null]) assert.equal(isCadFontResult(request, invalid), false);
  assert.equal(isCadFontResult({ file_name: 'Custom.ttf' }, { ...result, file_name: 'Custom.ttf' }), false);
});

test('annotation size uses geometry span, physical units and nice scales independently of world origin', () => {
  assert.deepEqual(annotationSize([geometry()], 4), { paperScale: 50, modelScale: 50, textHeight: 125 });
  assert.deepEqual(annotationSize([geometry(6)], 6), { paperScale: 50, modelScale: 0.05, textHeight: 0.125 });
  assert.deepEqual(annotationSize([geometry(6000, 100000000), { ...geometry(1e9), type: 'Text' }, { ...geometry(1e9), layer: 'SITECAD_GEOREF' }], 4), annotationSize([geometry()], 4));
  assert.deepEqual(annotationSize([], 4), { paperScale: 5, modelScale: 5, textHeight: 12.5 });
  assert.throws(() => annotationSize([], 0), /단위/);
  for (const value of Object.values(annotationSize([geometry(Number.MAX_VALUE)], 11))) assert.ok(Number.isFinite(value) && value > 0);
});
test('text defaults to a dedicated Korean style and preserves explicit fields and existing styles', async t => {
  mockFont(t); const e = engine(); const before = structuredClone(e.records());
  const request = { op: 'entities_create', entities: [{ type: 'Text', value: '한글' }, { type: 'MText', style: 'Custom', height: 99, value: '기존' }] };
  const prepared = await prepareText(e.cad, request, 4, e.io);
  assert.equal(prepared.request.entities[0].style, 'SiteCAD_KO'); assert.equal(prepared.request.entities[0].height, 125);
  assert.deepEqual(prepared.request.entities[1], request.entities[1]); assert.equal(request.entities[0].style, undefined);
  assert.deepEqual(e.records().text_styles[0], before.text_styles[0]);
  await prepareText(e.cad, request, 4, e.io);
  assert.equal(e.calls.filter(c => c.op === 'font_register').length, 1);
});
test('Windows font metadata selects Malgun Gothic for text and dimensions without changing imported styles', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 1, 0, 0]), { headers: { 'X-SiteCAD-CAD-Font': 'malgun.ttf' } }));
  const e = engine({ textStyles: [style('Standard', '20', 'malgun.ttf')] });
  const text = await prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text', value: '한글' }] }, 4, e.io);
  const dim = await prepareDimension(e.cad, ['D'], 4, e.io);
  assert.equal(text.annotation.font, 'malgun.ttf'); assert.equal(dim.font, 'malgun.ttf');
  assert.equal(e.calls.find(call => call.op === 'font_register').file_name, 'malgun.ttf');
  assert.equal(e.calls.filter(call => call.op === 'font_register').length, 1);
  assert.equal(e.records().text_styles.find(record => record.name === 'SiteCAD_KO').properties.font_file, 'malgun.ttf');
  assert.equal(dim.textHeight, 125);
});
test('unapproved font metadata and a different existing SiteCAD font stop before writes', async t => {
  for (const font of ['../../secret.ttf', 'Custom.ttf', 'malgun.ttf']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 1, 0, 0]), { headers: { 'X-SiteCAD-CAD-Font': font } }));
    const e = engine({ textStyles: [style('SiteCAD_KO', '40', 'AppleGothic.ttf')] });
    await assert.rejects(prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text', value: '한글' }] }, 4, e.io), /글꼴|스타일/);
    assert.equal(e.calls.some(call => ['font_register', 'run', 'set_properties'].includes(call.op)), false);
  }
});
test('unknown style collisions, font failures and guard changes stop annotation writes', async t => {
  mockFont(t); const request = { op: 'entities_create', entities: [{ type: 'Text', value: '한글' }] };
  const collision = engine({ textStyles: [style('SiteCAD_KO', '40', 'Custom.ttf')] });
  await assert.rejects(prepareText(collision.cad, request, 4, collision.io), /스타일/);
  assert.equal(collision.calls.some(c => c.op === 'run'), false);
  const stale = engine(); stale.io.check = async () => { throw Error('도면 변경'); };
  await assert.rejects(prepareText(stale.cad, request, 4, stale.io), /변경/); assert.equal(stale.calls.some(c => c.op === 'run' || c.op === 'font_register'), false);
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  const missing = engine(); await assert.rejects(prepareText(missing.cad, request, 4, missing.io), /글꼴/);
});
test('pagination is bounded and checked before styles are changed', async t => {
  mockFont(t); const e = engine({ pages: request => ({ ok: true, entities: Array.from({ length: 200 }, () => geometry()), next_offset: (request.offset || 0) + 200 }) });
  await assert.rejects(prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text' }] }, 4, e.io), /범위/);
  assert.equal(e.calls.some(c => c.op === 'run'), false);
});
test('new dimensions use a dedicated scale style without changing imported styles or unowned entities', async t => {
  mockFont(t); const original = { name: 'ISO-25', handle: '30', properties: { dimtxt: 0.18 } }; const e = engine({ dimStyles: [original] });
  const result = await prepareDimension(e.cad, ['D'], 4, e.io);
  assert.equal(result.textHeight, 125); assert.equal(result.style, 'SiteCAD_DIM');
  assert.deepEqual(e.records().dim_styles[0], original);
  const created = e.records().dim_styles.find(s => s.name === result.style).properties;
  assert.equal(created.dimscale, 50); assert.equal(created.dimtxsty, 'Standard'); assert.equal(created.dimtxsty_handle, 32);
  assert.equal(e.entities().find(e => e.handle === 'D').properties.Linear.base.style_name, result.style);
  const assignment = e.calls.find(c => c.collection === 'entities'); assert.equal(assignment.updates[0].path, '/Linear/base/style_name'); assert.equal(assignment.updates[0].expected, 'ISO-25');
});
test('a dedicated dimension style locks later dimension and text sizes', async t => {
  mockFont(t); const e = engine(); const first = await prepareDimension(e.cad, ['D'], 4, e.io);
  e.setEntities([geometry(600000), ...e.entities().filter(entity => entity.type === 'Dimension')]);
  const next = await prepareDimension(e.cad, ['D'], 4, e.io);
  assert.equal(next.modelScale, first.modelScale);
  const text = await prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text' }] }, 4, e.io);
  assert.equal(text.annotation.textHeight, first.textHeight);
  assert.equal(e.calls.filter(call => call.cmd === 'DIMSTYLE NEW SiteCAD_DIM').length, 1);
});
test('ambiguous zero-handle dimension styles never get patched', async t => {
  mockFont(t); const e = engine({ dimStyles: [{ name: 'OtherNewStyle', handle: '0', properties: {} }] });
  await assert.rejects(prepareDimension(e.cad, ['D'], 4, e.io), /스타일/);
  assert.equal(e.calls.some(call => call.collection === 'dim_styles' && call.op === 'set_properties'), false);
});
test('only a marked blank document can change its Standard font', async t => {
  mockFont(t);
  for (const marker of [undefined, 2, 1]) {
    const e = engine({ textStyles: [style('Standard', '20', 'txt.shx')] });
    e.cad.createdDocumentId = marker;
    await prepareDimension(e.cad, ['D'], 4, e.io);
    assert.equal(e.records().text_styles.find(s => s.name === 'Standard').properties.font_file, marker === 1 ? 'AppleGothic.ttf' : 'txt.shx');
  }
  const e = engine({ textStyles: [style('Standard', '20', 'txt.shx')], entities: [geometry(), dimension, { handle: 'T', type: 'Text', properties: { style: 'Standard' } }] });
  e.cad.createdDocumentId = 1;
  await prepareDimension(e.cad, ['D'], 4, e.io);
  assert.equal(e.records().text_styles[0].properties.font_file, 'txt.shx');
});
test('empty and non-dimension results require no font or style writes', async () => {
  const e = engine(); assert.equal(await prepareDimension(e.cad, [], 4, e.io), null);
  assert.equal(await prepareDimension(e.cad, ['A'], 4, e.io), null);
  assert.equal(e.calls.some(c => c.op === 'font_register' || c.op === 'run'), false);
});

test('explicit custom text styles skip font writes and failed writes remain visible', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected font request'); });
  const e = engine();
  const request = { op: 'entities_create', entities: [{ type: 'Text', style: 'UserFont', height: 20 }] };
  assert.deepEqual((await prepareText(e.cad, request, 4, e.io)).request, request);
  assert.equal(e.calls.some(call => ['run', 'font_register'].includes(call.op)), false);
  mockFont(t); const rejected = engine({ failWrite: true });
  await assert.rejects(prepareText(rejected.cad, { op: 'entities_create', entities: [{ type: 'Text' }] }, 4, rejected.io), /write rejected/);
});
test('dimension-only meter drawings use their own span and imported style collisions stop changes', async t => {
  mockFont(t); const dim = { ...dimension, bounds: { min: [0, 0, 0], max: [6, 0, 0] } };
  const e = engine({ entities: [dim, { ...geometry(1e9), layer: 'SITECAD_GEOREF' }] });
  const result = await prepareDimension(e.cad, ['D'], 6, e.io);
  assert.equal(result.modelScale, 0.05); assert.equal(result.textHeight, 0.125);
  const collision = engine({ dimStyles: [{ name: 'SiteCAD_DIM', handle: '40', properties: { dimscale: 1, dimtxt: 99 } }] });
  await assert.rejects(prepareDimension(collision.cad, ['D'], 4, collision.io), /스타일/);
  assert.equal(collision.calls.some(call => ['run', 'font_register', 'set_properties'].includes(call.op)), false);
});

test('model extents exclude layout and block contents while layout text requires explicit height', async t => {
  mockFont(t); const foreign = { ...geometry(1e9), handle: 'F', properties: { common: { owner_handle: 99 } } };
  const e = engine({ entities: [geometry(), foreign] });
  assert.equal((await prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text' }] }, 4, e.io)).annotation.textHeight, 125);
  e.io.layout = 'Layout1';
  await assert.rejects(prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text' }] }, 4, e.io), /모델 공간/);
  const custom = await prepareText(e.cad, { op: 'entities_create', entities: [{ type: 'Text', height: 10, style: 'Custom' }] }, 4, e.io);
  assert.equal(custom.annotation, null);
});
test('dimension preparation before drawing creates the style without assigning existing objects', async t => {
  mockFont(t); const e = engine(); e.io.prepareOnly = true;
  const result = await prepareDimension(e.cad, [], 4, e.io);
  assert.equal(result.style, 'SiteCAD_DIM'); assert.equal(result.textHeight, 125);
  assert.equal(e.calls.some(call => call.collection === 'entities'), false);
});
test('missing or substituted owned dimension handles never modify styles', async () => {
  const e = engine();
  await assert.rejects(prepareDimension(e.cad, ['MISSING'], 4, e.io), /생성한 치수/);
  assert.equal(e.calls.some(call => ['run', 'font_register', 'set_properties'].includes(call.op)), false);
});

test('existing attributes and other annotations keep their shared Standard font',async t=>{
  mockFont(t);
  for(const type of ['AttributeDefinition','AttributeEntity','MultiLeader','Leader','Table','Insert']){
    const e=engine({textStyles:[style('Standard','20','txt.shx')],entities:[geometry(),dimension,{handle:'B',type,properties:{text_style:'Standard'}}]});e.cad.createdDocumentId=1;
    await prepareDimension(e.cad,['D'],4,e.io);
    assert.equal(e.records().text_styles[0].properties.font_file,'txt.shx',type);
  }
});
