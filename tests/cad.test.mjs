import test from 'node:test';
import assert from 'node:assert/strict';
import { mmPerUnit, entityDefinition, CadEditor } from '../public/cad.js';
import { validateChat } from '../lib/plan.mjs';
import { executeDesktopCad } from '../public/desktop.js';

test('millimetre plans convert to existing metre drawings without changing their units', () => {
  assert.equal(mmPerUnit(4), 1);
  assert.equal(mmPerUnit(6), 1000);
  assert.throws(() => mmPerUnit(0), /단위/);
  assert.deepEqual(entityDefinition({ type: 'rectangle', x_mm: 0, y_mm: 0,
    width_mm: 6000, height_mm: 4000 }, 6), {
    type: 'LwPolyline', vertices: [[0, 0, 0], [6, 0, 0], [6, 4, 0], [0, 4, 0]],
    closed: true, layer: 'AI_DRAFT'
  });
  assert.deepEqual(entityDefinition({ type: 'circle', x_mm: 1000, y_mm: 2000, radius_mm: 500 }, 6),
    { type: 'Circle', center: [1, 2, 0], radius: 0.5, layer: 'AI_DRAFT' });
});

test('invalid dimensions and unrecognised operations cannot enter the engine', () => {
  assert.throws(() => entityDefinition({ type: 'circle', x_mm: 0, y_mm: 0, radius_mm: -1 }, 4));
  assert.throws(() => entityDefinition({ type: 'line', x1_mm: 0, y1_mm: 0, x2_mm: NaN, y2_mm: 0 }, 4));
  assert.throws(() => entityDefinition({ type: 'run', cmd: 'DELETE ALL' }, 4));
});

test('plans use captured document revision and selection, never freshen a stale plan silently', async () => {
  const cad = new CadEditor({ contentWindow: { ocsControl: { request: async () => ({
    ok: true, document_id: 1, revision: 3, selection: ['A']
  }) } } });
  await assert.rejects(cad.executePlan({ base: { documentId: 1, revision: 2, units: 4, selection: ['A'] },
    operations: [{ type: 'move', target: 'selection', dx_mm: 500, dy_mm: 0 }] }), /변경/);
});

test('OCS logical failure is rejected even when the control request resolved', async () => {
  const cad = new CadEditor({ contentWindow: { ocsControl: { request: async () => ({
    ok: false, error: 'revision_conflict'
  }) } } });
  await assert.rejects(cad.snapshot(), /revision_conflict/);
});

function engine(units = 4) {
  const state = { ok: true, document_id: 1, revision: 1, selection: [], documents: [{ id: 1 }] };
  const calls = [];
  let saved = new TextEncoder().encode('AC1032checked-dwg-bytes');
  const control = { ready: Promise.resolve(), request: async (request) => {
    calls.push(request);
    if (request.op === 'state') return structuredClone(state);
    if (request.op === 'capabilities') return { ok: true, operations: { entities_create: true, entities_transform: true, sysvar: true } };
    if (request.op === 'header') return { ok: true, insertion_units: units };
    if (request.op === 'records' && request.collection === 'header') return {ok:true,records:[{properties:{dimension_associativity:1}}]};
    if (request.op === 'query') return { ok: true, document_id: state.document_id, geometry_revision: state.revision,
      count: 1, returned: 1, next_offset: null,
      entities: [{ handle: '7F', type: 'LwPolyline', layer: 'AI_DRAFT', bounds: [0, 0, 6, 4], text: 'private annotation' }] };
    if (request.op === 'measure') return { ok: true, measurements: [{ handle: '7F', curve: { length: 20, area: 24 } }] };
    if (request.op === 'audit') return { ok: true, summary: { errors: 0 }, target: { dropped_on_save: 0 } };
    if (request.op === 'sysvar') units = request.set.insunits;
    if (request.op === 'new') { state.document_id++; state.documents = [{ id: state.document_id }]; }
    state.revision++;
    if (request.op === 'save') return { ok: true, result: { dropped_on_save: 0, bytes: saved.length, data_base64: Buffer.from(saved).toString('base64') } };
    return { ok: true, result: { created: 1, handles: ['7F'], affected: request.handles?.length } };
  } };
  const cad = new CadEditor({ contentWindow: { ocsControl: control } });
  return { cad, state, calls, control, corruptSave: () => { saved = new TextEncoder().encode('AC1021wrong-version'); } };
}

test('context exposes only owned pending prompts and saving remains blocked until command completion', async () => {
  const {cad,state,control,calls} = engine();
  const original = control.request;
  control.request = async request => {
    if (request.op === 'commands') return {ok:true,command:{name:request.name}};
    if (request.op === 'start') {
      state.command = {name:'DIMLINEAR',accepts:['point','enter'],prompt:'First origin'};
      return {ok:true,status:'waiting_input',state:structuredClone(state)};
    }
    if (request.op === 'cancel') {state.command = null;return {ok:true,status:'cancelled',state:structuredClone(state)};}
    return original(request);
  };
  await cad.control({request:{op:'start',cmd:'DIMLINEAR'},expectedContext:await cad.context()});
  const pendingContext=await cad.context();
  assert.equal(pendingContext.command.name,'DIMLINEAR');
  assert.throws(()=>validateChat({message:'새 도면 요청',context:pendingContext,history:[]}),/도면 상태/);
  await assert.rejects(cad.save('pending.dwg'),/진행 중/);
  assert.equal(calls.some(call=>call.op==='save'),false);
  assert.deepEqual(await cad.cancelPendingCommand(),{cancelled:true});
  assert.equal((await cad.context()).command,null);
  state.command={name:'LINE',accepts:['point']};
  await assert.rejects(cad.context(),/진행 중/);
  assert.deepEqual(await cad.cancelPendingCommand(),{cancelled:false});
  assert.equal(state.command.name,'LINE');
});

test('editor startup, new drawing and context preserve units and omit annotation content', async () => {
  const { cad, state } = engine(6);
  await cad.ready();
  await cad.newDrawing();
  const context = await cad.context();
  assert.equal(context.units, 4);
  assert.equal(context.documentId, state.document_id);
  assert.equal(cad.sourceVersion, 'AC1032');
  assert.equal(cad.createdDocumentId, state.document_id);
  assert.deepEqual(Object.keys(context.entities[0]), ['handle', 'type', 'layer', 'bounds']);
  assert.ok(!JSON.stringify(context).includes('private annotation'));
});

test('new blank document initializes units after its first render changes geometry epoch', async()=>{
  const {cad,control,state}=engine();state.geometry_revision=1;
  const original=control.request;let fresh=false;
  control.request=async request=>{
    const reply=await original(request);
    if(request.op==='state' && state.document_id===2 && !fresh){fresh=true;state.geometry_revision++;}
    return reply;
  };
  await cad.newDrawing();
  assert.equal((await cad.request({op:'header'})).insertion_units,4);
  assert.equal(fresh,true);
});

test('native mutations retain geometry guards except explicit document lifecycle without an expected state', async()=>{
  const {cad,state,calls}=engine();state.geometry_revision=7;
  await cad.mutate({op:'undo'});
  assert.equal(calls.findLast(call=>call.op==='undo').geometry_revision,7);
  await cad.mutate({op:'new'});
  assert.equal(Object.hasOwn(calls.findLast(call=>call.op==='new'),'geometry_revision'),false);
  await cad.mutate({op:'open',name:'test.dwg',data_base64:''},await cad.snapshot());
  assert.equal(calls.findLast(call=>call.op==='open').geometry_revision,7);
});

test('failed dimension setting restoration blocks context, mutations, saving and completion until cleanup succeeds', async()=>{
  const {cad,control,state}=engine();let mode=2,failRestore=true;
  const original=control.request;
  control.request=async request=>{
    if(request.op==='commands')return {ok:true,command:{name:request.name}};
    if(request.op==='records' && request.collection==='header')return {ok:true,records:[{properties:{dimension_associativity:mode}}]};
    if(request.op==='run' && request.cmd.startsWith('SETVAR DIMASSOC')){
      const value=Number(request.cmd.split(' ').at(-1));
      if(value===2 && failRestore)return {ok:false,error:'restore_denied'};
      mode=value;state.revision++;
      return {ok:true,status:'completed',state:structuredClone(state)};
    }
    if(request.op==='start')return {ok:true,status:'completed',state:structuredClone(state)};
    return original(request);
  };
  await assert.rejects(cad.control({request:{op:'start',cmd:'DIMLINEAR'},expectedContext:await cad.context()}),/복원/);
  assert.equal(mode,1);
  await assert.rejects(cad.context(),/복원/);
  await assert.rejects(cad.mutate({op:'undo'}),/복원/);
  await assert.rejects(cad.save('unrestored.dwg'),/복원/);
  await assert.rejects(executeDesktopCad(cad,{method:'completion_state'}),/복원/);
  failRestore=false;
  assert.deepEqual(await cad.cancelPendingCommand(),{cancelled:false});
  assert.equal(mode,2);
  assert.equal((await cad.context()).command,null);
});

test('actual idle editor context is accepted by the chat boundary including command null', async () => {
  const {cad,state}=engine();
  state.geometry_revision=7;state.layout='Model';
  const context=await cad.context();
  assert.equal(context.command,null);
  assert.equal(context.geometryRevision,7);
  assert.equal(context.layout,'Model');
  const request={message:'선 하나 그려줘',context,history:[]};
  assert.equal(validateChat(request),request);
});

test('startup handles an autosave dialog arriving while the initial blank drawing opens', async () => {
  const { cad, control, state } = engine();
  state.documents = [{ id: 1, start: true }];
  const original = control.request;
  let shown = false;
  control.request = async request => {
    const reply = await original(request);
    if (request.op === 'new' && !shown) { state.modal = 'AutosaveRestore'; shown = true; }
    if (request.op === 'action' && request.name === 'close_modal') state.modal = null;
    return reply;
  };
  const ready = await cad.ready();
  assert.equal(ready.modal, null);
  assert.equal(ready.units, 4);
});

test('create, move last and measure execute in order in a metre drawing', async () => {
  const { cad, calls } = engine(6);
  const base = await cad.context();
  const result = await cad.executePlan({ base, operations: [
    { type: 'rectangle', x_mm: 0, y_mm: 0, width_mm: 6000, height_mm: 4000 },
    { type: 'move', target: 'last', dx_mm: 500, dy_mm: 0 },
    { type: 'measure', target: 'last' }
  ] });
  assert.match(result.message, /생성 완료/);
  assert.match(result.message, /길이 20m/);
  assert.match(result.message, /면적 24m²/);
  assert.deepEqual(calls.find(call => call.op === 'entities_transform').vector, [0.5, 0, 0]);
  assert.deepEqual(calls.find(call => call.op === 'entities_create').entities[0].vertices[2], [6, 4, 0]);
  await cad.undo();
  assert.deepEqual(cad.lastHandles, []);
});

test('selection and units must match the planned context; no missing target is inferred', async () => {
  const { cad, state } = engine();
  const base = await cad.context();
  await assert.rejects(cad.executePlan({ base: { ...base, units: 6 }, operations: [] }), /단위가 변경/);
  state.selection = ['A'];
  await assert.rejects(cad.executePlan({ base, operations: [] }), /선택이 변경/);
  state.selection = [];
  await assert.rejects(cad.executePlan({ base, operations: [{ type: 'move', target: 'last', dx_mm: 1, dy_mm: 0 }] }), /선택/);
  assert.deepEqual(await cad.executePlan({ base, reply: '치수를 알려 주세요', operations: [] }), { message: '치수를 알려 주세요', details: [] });
  state.modal = 'dialog';
  await assert.rejects(cad.context(), /대화상자/);
  await assert.rejects(cad.fit(), /대화상자/);
});

test('opening a DWG validates the format and clears stale last-created handles', async () => {
  const { cad, calls } = engine(6);
  cad.lastHandles = ['old'];
  cad.createdDocumentId = 1;
  await assert.rejects(cad.openFile(new File(['notdwg'], 'bad.dwg')), /헤더/);
  await assert.rejects(cad.openFile(new File(['x'], 'bad.txt')), /DWG/);
  await cad.openFile(new File(['AC1032test'], 'sample.dwg'));
  assert.equal(cad.units, 6);
  assert.deepEqual(cad.lastHandles, []);
  assert.equal(cad.createdDocumentId, null);
  assert.equal(Buffer.from(calls.find(call => call.op === 'open').data_base64, 'base64').toString(), 'AC1032test');
});

test('DWG save requires a lossless audit, matching bytes and original version', async () => {
  const { cad, control, corruptSave } = engine();
  const result = await cad.save('checked.dwg');
  assert.equal(new TextDecoder().decode(result.bytes).slice(0, 6), 'AC1032');
  await assert.rejects(cad.save('../wrong.dwg'), /파일명/);
  corruptSave();
  await assert.rejects(cad.save('wrong-version.dwg'), /버전/);
  const original = control.request;
  control.request = request => request.op === 'audit'
    ? Promise.resolve({ ok: true, summary: { errors: 1 } }) : original(request);
  await assert.rejects(cad.save('lossy.dwg'), /데이터 손실/);
});

test('deletion uses captured targets, confirms absence, and clears last-created objects', async () => {
  const { cad, state, control, calls } = engine();
  state.selection = ['7F'];
  const original = control.request;
  let deleted = false;
  control.request = async request => {
    if (request.op === 'entities_delete') { calls.push(request); deleted = true; state.revision++; return { ok: true, result: { erased: 1 } }; }
    if (request.op === 'query' && deleted && request.handles) return { ok: true, entities: [] };
    return original(request);
  };
  const result = await cad.executePlan({ base: await cad.context(), operations: [{ type: 'delete', target: 'selection' }] });
  assert.match(result.message, /삭제/);
  assert.deepEqual(calls.find(call => call.op === 'entities_delete').handles, ['7F']);
  assert.deepEqual(cad.lastHandles, []);
});

test('MCP DWG save refuses a document that changed after its context was captured', async () => {
  const { cad, state, calls } = engine();
  const expected = await cad.context(); state.revision++;
  await assert.rejects(cad.save('stale.dwg', expected), /변경/);
  assert.equal(calls.some(call => call.op === 'save'), false);
});

test('DWG save refuses a document switch between expected-context validation and its save snapshot', async () => {
  const {cad,state,calls,control}=engine();
  state.geometry_revision=1;state.layout='Model';
  const expected=await cad.context();
  const original=control.request;
  let changed=false;
  control.request=async request=>{
    const reply=await original(request);
    if (request.op==='header' && !changed) {
      changed=true;state.document_id=2;state.documents=[{id:2}];
    }
    return reply;
  };
  await assert.rejects(cad.save('switched-before-save.dwg',expected));
  assert.equal(changed,true);
  assert.equal(calls.some(call=>call.op==='save'),false);
});

test('DWG save never reports success when document geometry or units change during native saving', async t => {
  for (const changedField of ['document','geometry','units']) await t.test(changedField,async()=>{
    const {cad,state,control,calls}=engine();
    state.geometry_revision=1;state.layout='Model';
    const expected=await cad.context();
    const original=control.request;
    let changedUnits;
    control.request=async request=>{
      const reply=await original(request);
      if (request.op==='save') {
        if (changedField==='document') {state.document_id=2;state.documents=[{id:2}];}
        if (changedField==='geometry') state.geometry_revision++;
        if (changedField==='units') changedUnits=6;
      }
      return request.op==='header' && changedUnits ? {...reply,insertion_units:changedUnits} : reply;
    };
    await assert.rejects(cad.save(`changed-${changedField}.dwg`,expected));
    assert.equal(calls.filter(call=>call.op==='save').length,1);
  });
});

test('DWG save accepts native save revision changes when document geometry and units remain stable', async () => {
  const {cad,state,calls}=engine();
  state.geometry_revision=1;state.layout='Model';
  const expected=await cad.context();
  const saved=await cad.save('stable-save.dwg',expected);
  assert.equal(saved.name,'stable-save.dwg');
  assert.equal(saved.audit.errors,0);
  assert.equal(state.revision,expected.revision+1);
  assert.equal(state.geometry_revision,expected.geometryRevision);
  assert.equal(calls.filter(call=>call.op==='save').length,1);
});

test('cancellation stops remaining operations in an already-started batch', async () => {
  const { cad, control, calls } = engine();
  const base = await cad.context(); const abort = new AbortController();
  const original = control.request;
  control.request = async request => {
    const result = await original(request);
    if (request.op === 'entities_create') abort.abort();
    return result;
  };
  await assert.rejects(cad.executePlan({ base, operations: [
    { type: 'circle', x_mm: 0, y_mm: 0, radius_mm: 100 },
    { type: 'circle', x_mm: 500, y_mm: 0, radius_mm: 100 }
  ] }, { signal: abort.signal }), /취소/);
  assert.equal(calls.filter(call => call.op === 'entities_create').length, 1);
});

test('a later failure clearly reports prior applied operations', async () => {
  const { cad } = engine();
  const base = await cad.context();
  await assert.rejects(cad.executePlan({ base, operations: [
    { type: 'line', x1_mm: 0, y1_mm: 0, x2_mm: 1000, y2_mm: 0 }, { type: 'unsupported' }
  ] }), /1개 작업은 이미 완료/);
  await cad.executePlan({ base: await cad.context(), operations: [{ type: 'undo' }] });
  assert.deepEqual(cad.lastHandles, []);
});

test('a first write followed by failed verification warns against blindly retrying', async () => {
  const { cad, control } = engine();
  const base = await cad.context();
  const original = control.request;
  control.request = request => request.op === 'query'
    ? Promise.resolve({ ok: true, entities: [] }) : original(request);
  await assert.rejects(cad.executePlan({ base, operations: [
    { type: 'circle', x_mm: 0, y_mm: 0, radius_mm: 1000 }
  ] }), /도면이 변경되었을 수 있습니다.*실행 취소/);
});

test('quantity review returns a whole-drawing report without modifying drawing or camera', async () => {
  const { cad, state, calls, control } = engine(6);
  const original = control.request;
  control.request = async request => {
    const common = { ok: true, document_id: 1, geometry_revision: 1 };
    if (request.op === 'records' || request.op === 'query') {
      calls.push(request);
      const field = request.op === 'records' ? 'records' : 'entities';
      return { ...common, count: 1, returned: 1, next_offset: null, [field]: field === 'records'
        ? [{ handle: '1F', name: '*Model_Space' }]
        : [{ handle: '7F', layer: 'AI_DRAFT', properties: { common: { owner_handle: 31 } } }] };
    }
    if (request.op === 'measure') return { ...common,
      measurements: [{ handle: '7F', curve: { closed: true, length: 20, area: 24 } }] };
    return original(request);
  };
  const base = { documentId: 1, revision: 1, units: 6, selection: [] };
  const report = await cad.executePlan({ base, operations: [{ type: 'quantity_review' }] });
  assert.equal(report.reports[0].totals.count, 1);
  assert.equal(report.reports[0].totals.lengthM, 20);
  assert.equal(report.reports[0].totals.areaM2, 24);
  assert.equal(state.revision, 1);
  assert.ok(calls.every(call => ['state', 'header', 'records', 'query'].includes(call.op)));
  await assert.rejects(cad.executePlan({ base, operations: [{ type: 'quantity_review' }, { type: 'undo' }] }), /물량검토/);
  const stable = control.request;
  control.request = async request => {
    const reply = await stable(request);
    if (request.op === 'measure') state.revision++;
    return reply;
  };
  await assert.rejects(cad.executePlan({ base, operations: [{ type: 'quantity_review' }] }), /집계 중 도면/);
});
