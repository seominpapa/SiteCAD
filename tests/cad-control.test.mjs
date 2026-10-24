import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDrawing, queryDrawing, controlDrawing, cancelOwnedCommand, hasPendingCompatibility } from '../public/cad-control.js';

function engine({ anchored = false, incomplete = false, replyError = false, changedReply = false, replyEvent = false, units = 4, dimensionMode = 1, command = { name: 'LINE', accepts: ['point'] } } = {}) {
  let state = { document_id: 1, revision: 3, geometry_revision: 5, layout: 'Model', selection: [], command: null, modal: null };
  const calls = [];
  const base = { documentId: 1, revision: 3, geometryRevision: 5, layout: 'Model', selection: [], units };
  const cad = { lastHandles: [], snapshot: async () => structuredClone(state), request: async request => {
    calls.push(request);
    if (request.op === 'commands') return { ok: true, command: { name: request.name, category: request.name.startsWith('DIM') ? 'annotate' : request.name === 'MOVE' ? 'modify' : 'create' } };
    if (request.op === 'records' && request.collection === 'header') return {ok:true,records:[{properties:{dimension_associativity:dimensionMode}}]};
    if (request.op === 'header') return { ok: true, insertion_units: units };
    if (request.op === 'query') return { ok: true, entities: request.layer ? (anchored ? [{ handle: 'FE', layer: 'SITECAD_GEOREF' }] : []) : (request.handles || []).map(handle => ({ handle, layer: handle === 'FE' ? 'SITECAD_GEOREF' : 'AI_DRAFT' })) };
    return { ok: true, measurements: [{ handle: 'A', curve: { length: 4, area: 2 } }] }; } };
  const request = async value => {
    calls.push(value);
    if ((value.op === 'set_properties' && value.collection === 'header') || (value.op === 'run' && /^SETVAR DIMASSOC [12]$/.test(value.cmd))) {
      if(value.op==='set_properties') assert.equal(value.updates[0].expected, dimensionMode);
      dimensionMode = value.op==='set_properties' ? value.updates[0].value : Number(value.cmd.at(-1));
      state = {...state,revision:state.revision+1,geometry_revision:state.geometry_revision+1};
      return {ok:true,status:'completed',state:structuredClone(state)};
    }
    if (value.op === 'cancel') { state = { ...state, command: null }; return { ok: true, status: 'cancelled', state: structuredClone(state) }; }
    if (replyError) return { ok: false, error: 'invalid_point' };
    state = { ...state, revision: state.revision + 1, geometry_revision: state.geometry_revision + 1,
      ...(value.op === 'select' ? { selection: value.clear ? [] : value.handles } : {}),
      ...(value.op === 'action' && value.name === 'layout_switch' ? {layout:value.value,selection:[]} : {}),
      ...(incomplete ? { command: structuredClone(command) } : {}) };
    const result = { ok: true, status: incomplete ? 'waiting_input' : 'completed', result: { handles: ['B'], created: 1 }, state: structuredClone(state) };
    if (changedReply) state = { ...state, revision: state.revision + 1 };
    if (replyEvent) state = {...state,event_cursor:(state.event_cursor || 0)+1};
    return result;
  };
  cad.iframe = { contentWindow: { ocsControl: { request } } };
  return { cad, base, calls, mode:()=>dimensionMode, setState: value => { state = { ...state, ...value }; } };
}

test('discovery and measurements preserve native drawing units', async () => {
  const { cad, base, calls } = engine({ units: 6 });
  assert.equal((await discoverDrawing(cad, { request: { op: 'commands', name: 'LINE' } })).coordinateUnits, 'drawing units');
  const data = await queryDrawing(cad, { request: { op: 'measure', handles: ['A'] }, expectedContext: base });
  assert.equal(data.mmPerDrawingUnit, 1000);
  assert.equal(data.result.measurements[0].curve.length, 4);
  assert.ok(calls.some(call => call.op === 'measure'));
});

test('3D native measurements preserve volume and surface area without converting raw values', async () => {
  const value=engine({units:6});const native=value.cad.request;
  value.cad.request=async request=>request.op==='measure'?{ok:true,measurements:[{handle:'A',mesh:{volume:24,surface_area:52}}]}:native(request);
  const reply=await queryDrawing(value.cad,{request:{op:'measure',handles:['A']},expectedContext:value.base});
  assert.deepEqual(reply.result.measurements,[{handle:'A',mesh:{volume:24,surface_area:52}}]);
  assert.equal(reply.mmPerDrawingUnit,1000);
  assert.equal(reply.units,6);
});

test('3D interactive input preserves Z while stale state and georeference guards still stop execution', async () => {
  const value=engine({incomplete:true,command:{name:'3DPOLY',accepts:['point']}});
  assert.equal((await controlDrawing(value.cad,{request:{op:'start',cmd:'3DPOLY'},expectedContext:value.base})).status,'waiting_input');
  const state=await value.cad.snapshot();
  const expectedContext={...value.base,revision:state.revision,geometryRevision:state.geometry_revision};
  await controlDrawing(value.cad,{request:{op:'input',kind:'point',point:[10,20,300],space:'wcs'},expectedContext});
  assert.deepEqual(value.calls.find(call=>call.op==='input').point,[10,20,300]);
  await assert.rejects(controlDrawing(value.cad,{request:{op:'input',kind:'point',point:[40,50,600]},expectedContext}),/변경/);
  assert.equal(value.calls.filter(call=>call.op==='input').length,1);
  const creation=engine({anchored:true});
  await controlDrawing(creation.cad,{request:{op:'start',cmd:'BOX'},expectedContext:creation.base});
  for(const cmd of ['EXTRUDE','UNION','3DMOVE']) {
    const editing=engine({anchored:true});
    await assert.rejects(controlDrawing(editing.cad,{request:{op:'start',cmd},expectedContext:editing.base}),/공간 기준/);
    assert.equal(editing.calls.some(call=>call.protocol===1),false);
  }
  for(const cmd of ['VIEW SWISO','VISUALSTYLES HIDDENLINE']) {
    const viewing=engine({anchored:true});
    assert.equal((await controlDrawing(viewing.cad,{request:{op:'run',cmd},expectedContext:viewing.base})).status,'completed');
  }
});

test('POLYSOLID cannot consume a preselected georeference path in an anchored drawing', async () => {
  const value=engine({anchored:true});
  value.setState({selection:['FE']});
  await assert.rejects(controlDrawing(value.cad,{request:{op:'start',cmd:'POLYSOLID'},expectedContext:{...value.base,selection:['FE']}}),/공간 기준/);
  assert.equal(value.calls.some(call=>call.protocol===1),false);
});

test('generic native record edits preserve explicit targets, compare values and drawing guards', async () => {
  for (const record of [
    {collection:'entities',handle:'A',type:'Line',properties:{common:{layer:'AI_DRAFT'},end:{x:100,y:0,z:0}}},
    {collection:'layers',handle:'B',name:'현장 도면',properties:{color:7}},
  ]) {
    const value=engine({anchored:true});
    const native=value.cad.request;
    value.cad.request=async request=>request.op==='records' ? {ok:true,records:[record],next_offset:null} : native(request);
    const request={op:'set_properties',collection:record.collection,handle:record.handle,updates:[record.collection==='entities'?{path:'/end/x',expected:100,value:200}:{path:'/color',expected:7,value:3}]};
    assert.equal((await controlDrawing(value.cad,{request,expectedContext:value.base})).status,'completed');
    assert.deepEqual(value.calls.find(call=>call.op==='set_properties').updates,request.updates);
  }
  const value=engine();
  value.cad.request=async request=>request.op==='records'?{ok:true,records:[]}:request.op==='header'?{ok:true,insertion_units:4}:{ok:true};
  await assert.rejects(controlDrawing(value.cad,{request:{op:'set_properties',collection:'entities',handle:'A',updates:[{path:'/end/x',expected:0,value:1}]},expectedContext:value.base}),/대상|확인/);
  assert.equal(value.calls.some(call=>call.op==='set_properties'),false);
});

test('sysvar reads use the native envelope without permitting changes during a read', async () => {
  const value=engine();
  value.cad.iframe.contentWindow.ocsControl.request=async request=>{value.calls.push(request);const state=await value.cad.snapshot();value.setState({event_cursor:1});return {ok:true,result:{clayer:'0',ltscale:1},state};};
  const reply=await queryDrawing(value.cad,{request:{op:'sysvar',get:['clayer','ltscale']},expectedContext:value.base});
  assert.equal(reply.result.result.clayer,'0');
  assert.equal(value.calls.find(call=>call.op==='sysvar').protocol,1);
  const changed=engine();
  await assert.rejects(queryDrawing(changed.cad,{request:{op:'sysvar',get:['clayer']},expectedContext:changed.base}),/변경/);
});

test('block replacement and forced deletion protect children and references outside the current layout', async () => {
  for (const request of [{op:'block_define',name:'검토블록',base:[0,0,0],handles:['A'],replace:true},{op:'block_delete',name:'검토블록',force:true}]) {
    for(const properties of [{common:{layer:'SITECAD_GEOREF',owner_handle:32}},{common:{layer:'SITECAD_GEOREF',owner_handle:1},block_name:'검토블록'}]) {
      const value=engine();const native=value.cad.request;
      value.cad.request=async req=>req.op!=='records'?native(req):{ok:true,records:req.collection==='block_records'?[{handle:'20',name:'검토블록'}]:[{handle:'FE',properties}],next_offset:null};
      await assert.rejects(controlDrawing(value.cad,{request,expectedContext:value.base}),/공간 기준/);
      assert.equal(value.calls.some(call=>call.protocol===1),false);
    }
  }
  const value=engine();const native=value.cad.request;
  value.cad.request=async req=>req.op!=='records'?native(req):{ok:true,records:req.collection==='block_records'?[{handle:'20',name:'검토블록'}]:[{handle:'A',properties:{common:{layer:'벽체',owner_handle:32}}}],next_offset:null};
  assert.equal((await controlDrawing(value.cad,{request:{op:'block_delete',name:'검토블록',force:true},expectedContext:value.base})).status,'completed');
});

test('block replacement refuses sources erased by replacement and unreadable ownership before dispatch', async () => {
  for(const properties of [{common:{layer:'벽체',owner_handle:32}},{common:{layer:'벽체',owner_handle:1},block_name:'검토블록'},{common:{layer:'SITECAD_GEOREF',owner_handle:Number.MAX_SAFE_INTEGER+1}}]) {
    const value=engine();const native=value.cad.request;
    value.cad.request=async req=>req.op!=='records'?native(req):{ok:true,records:req.collection==='block_records'?[{handle:'20',name:'검토블록'}]:[{handle:'A',properties}],next_offset:null};
    await assert.rejects(controlDrawing(value.cad,{request:{op:'block_define',name:'검토블록',base:[0,0,0],handles:['A'],replace:true},expectedContext:value.base}),/원본|소유|공간 기준/);
    assert.equal(value.calls.some(call=>call.protocol===1),false);
  }
});

test('record edits cannot target protected records indirectly by handle or through renamed layers', async () => {
  for (const record of [
    {collection:'entities',handle:'A',properties:{common:{layer:'SITECAD_GEOREF'},value:'anchor'}},
    {collection:'entities',handle:'A',properties:{common:{layer:'0'},value:'SITECAD_GEOREF_V1:payload'}},
    {collection:'entities',handle:'A',properties:{Linear:{base:{common:{layer:'SITECAD_GEOREF',owner_handle:32}}}}},
    {collection:'layers',handle:'A',name:'SITECAD_GEOREF',properties:{color:7}},
    {collection:'dim_styles',handle:'A',name:'SiteCAD_DIM',properties:{dimtxt:2.5}},
  ]) {
    const value=engine();const native=value.cad.request;
    value.cad.request=async request=>request.op==='records'?{ok:true,records:[record],next_offset:null}:native(request);
    await assert.rejects(controlDrawing(value.cad,{request:{op:'set_properties',collection:record.collection,handle:'A',updates:[{path:record.collection==='entities'?'/height':record.collection==='layers'?'/color':'/dimtxt',expected:1,value:2}]},expectedContext:value.base}),/공간 기준|보호|스타일/);
    assert.equal(value.calls.some(call=>call.op==='set_properties'),false);
  }
});

test('layout switching permits only the requested destination and retains document and unit guards', async () => {
  const value=engine();
  assert.equal((await controlDrawing(value.cad,{request:{op:'action',name:'layout_switch',value:'검토 배치'},expectedContext:value.base})).status,'completed');
  assert.equal((await value.cad.snapshot()).layout,'검토 배치');
  const wrong=engine();
  wrong.cad.iframe.contentWindow.ocsControl.request=async ()=>{wrong.setState({layout:'wrong'});return {ok:true,status:'completed',state:await wrong.cad.snapshot()};};
  await assert.rejects(controlDrawing(wrong.cad,{request:{op:'action',name:'layout_switch',value:'검토 배치'},expectedContext:wrong.base}),/변경|배치/);
});

test('viewport insert-view input is refused before changing layouts and the owned command can still cancel', async () => {
  const value=engine({incomplete:true,command:{name:'MVIEW',accepts:['token'],options:['INSERT','FIT']}});
  await controlDrawing(value.cad,{request:{op:'start',cmd:'MVIEW'},expectedContext:value.base});
  const state=await value.cad.snapshot(),context={...value.base,revision:state.revision,geometryRevision:state.geometry_revision};
  const before=value.calls.length;
  await assert.rejects(controlDrawing(value.cad,{request:{op:'input',kind:'token',text:'INSERT'},expectedContext:context}),/배치|뷰/);
  assert.equal(value.calls.slice(before).some(call=>call.op==='input'),false);
  assert.equal((await cancelOwnedCommand(value.cad)).cancelled,true);
});

test('safe native block and page operations use the same envelope and cannot bypass stale context', async () => {
  for (const request of [{op:'block_define',name:'검토블록',base:[0,0,0],handles:['A']},{op:'layout_create',name:'검토배치'},{op:'page_setup_set',layout:'Model',paper:'A3',scale:'1:50'},{op:'sysvar',set:{ltscale:2}}]) {
    const value=engine();
    assert.equal((await controlDrawing(value.cad,{request,expectedContext:value.base})).status,'completed');
    const stale=engine();stale.setState({revision:99});
    await assert.rejects(controlDrawing(stale.cad,{request,expectedContext:stale.base}),/변경/);
    assert.equal(stale.calls.some(call=>call.protocol===1),false);
  }
});

test('native mutation envelope checks geometry and exact selection at dispatch', async () => {
  const {cad,base,calls,setState} = engine();
  setState({selection:['B','A']});
  await controlDrawing(cad,{request:{op:'start',cmd:'LINE'},expectedContext:{...base,selection:['B','A']}});
  const sent=calls.find(call=>call.protocol===1);
  assert.equal(sent.geometry_revision,base.geometryRevision);
  assert.deepEqual(sent.selection,['B','A']);
});

test('properties reads requested full entities without using selection-based native properties', async () => {
  const { cad, base, calls } = engine();
  const original = cad.request;
  const entity = { handle: '85', type: 'Point', layer: 'AI_DRAFT', location: [10, 20, 30], properties: { location: { x: 10, y: 20, z: 30 } } };
  cad.request = async request => {
    if (request.op === 'properties') { calls.push(request); return { ok: true, title: 'Drawing', sections: [] }; }
    if (request.op === 'query') { calls.push(request); return { ok: true, entities: [entity], matched: 1, count: 1 }; }
    return original(request);
  };
  const result = await queryDrawing(cad, { request: { op: 'properties', handles: ['0085', '85'] }, expectedContext: base });
  assert.deepEqual(result.result.entities, [entity]);
  assert.equal(result.mmPerDrawingUnit, 1);
  assert.deepEqual(calls.find(call => call.op === 'query'), { op: 'query', handles: ['85'], detail: 'full', limit: 1 });
  assert.equal(calls.some(call => ['properties', 'select'].includes(call.op) || call.protocol === 1), false);
  assert.deepEqual((await cad.snapshot()).selection, []);
});

test('properties resolves up to 500 handles in bounded reads and rejects missing or substituted entities', async () => {
  const handles = Array.from({ length: 500 }, (_, index) => (index + 1).toString(16).toUpperCase());
  const { cad, base, calls } = engine();
  const result = await queryDrawing(cad, { request: { op: 'properties', handles }, expectedContext: base });
  assert.equal(result.result.entities.length, 500);
  assert.deepEqual(calls.filter(call => call.op === 'query').map(call => call.handles.length), [200, 200, 100]);
  for (const entities of [[], [null], [{ handle: 'B' }], [{ handle: 'A' }, { handle: 'A' }]]) {
    const value = engine();
    const original = value.cad.request;
    value.cad.request = async request => request.op === 'query' ? { ok: true, entities } : original(request);
    await assert.rejects(queryDrawing(value.cad, { request: { op: 'properties', handles: entities.length === 2 ? ['A', 'B'] : ['A'] }, expectedContext: value.base }), /속성.*확인/);
  }
});

test('properties retains drawing guards across batched reads', async () => {
  const handles = Array.from({ length: 201 }, (_, index) => (index + 1).toString(16).toUpperCase());
  for (const change of [{ revision: 4 }, { selection: ['A'] }, { document_id: 2 }, { geometry_revision: 6 }, { layout: 'Layout1' }]) {
    const { cad, base, setState } = engine();
    const original = cad.request;
    cad.request = async request => { const result = await original(request); if (request.op === 'query') setState(change); return result; };
    await assert.rejects(queryDrawing(cad, { request: { op: 'properties', handles }, expectedContext: base }), /변경/);
  }
  for (const mode of ['units', 'cancel']) {
    const { cad, base, calls } = engine();
    const abort = new AbortController();
    const original = cad.request;
    let queried = false;
    cad.request = async request => {
      if (request.op === 'header' && queried && mode === 'units') return { ok: true, insertion_units: 6 };
      const result = await original(request);
      if (request.op === 'query') { queried = true; if (mode === 'cancel') abort.abort(); }
      return result;
    };
    await assert.rejects(queryDrawing(cad, { request: { op: 'properties', handles }, expectedContext: base }, { signal: abort.signal }), /변경|취소/);
    assert.equal(calls.filter(call => call.op === 'query').length, 1);
  }
});

test('stale document, revision, geometry, selection, layout and units never write', async () => {
  for (const change of [{ document_id: 2 }, { revision: 4 }, { geometry_revision: 6 }, { selection: ['A'] }, { layout: 'Layout1' }]) {
    const { cad, base, setState, calls } = engine(); setState(change);
    await assert.rejects(controlDrawing(cad, { request: { op: 'undo' }, expectedContext: base }), /변경/);
    assert.equal(calls.some(call => call.op === 'undo'), false);
  }
  const { cad, base } = engine();
  await assert.rejects(controlDrawing(cad, { request: { op: 'undo' }, expectedContext: { ...base, units: 6 } }), /단위/);
});

test('query rejects concurrent user edits and cancellation without mutating', async () => {
  const { cad, base, setState } = engine();
  const original = cad.request;
  cad.request = async request => { const value = await original(request); if (request.op === 'measure') setState({ revision: 4 }); return value; };
  await assert.rejects(queryDrawing(cad, { request: { op: 'measure', handles: ['A'] }, expectedContext: base }), /변경/);
  await assert.rejects(queryDrawing(cad, { request: { op: 'layers' }, expectedContext: base }, { signal: AbortSignal.abort() }), /취소/);
});

test('transform, selection and typed creation run with application generated envelopes', async () => {
  for (const request of [
    { op: 'entities_create', entities: [{ type: 'Arc', center: [0, 0], radius: 4, start_angle_deg: 0, end_angle_deg: 90 }] },
    { op: 'entities_transform', handles: ['A'], action: 'rotate', center: [0, 0], angle_deg: 90 },
    { op: 'select', handles: ['A'] }
  ]) {
    const { cad, base, calls } = engine();
    const result = await controlDrawing(cad, { request, expectedContext: base });
    assert.equal(result.units, 4);
    assert.deepEqual(cad.lastHandles, ['B']);
    const sent = calls.find(call => call.protocol === 1);
    assert.equal(sent.document_id, 1); assert.equal(sent.revision, 3); assert.equal(typeof sent.request_id, 'string');
  }
});

test('reserved georeference entities cannot be created, deleted or transformed', async () => {
  for (const request of [
    { op: 'entities_create', entities: [{ type: 'Point', location: [0, 0], layer: 'sitecad_georef' }] },
    { op: 'entities_delete', handles: ['FE'] },
    { op: 'entities_transform', handles: ['FE'], action: 'move', vector: [1, 0] }
  ]) {
    const { cad, base, calls } = engine();
    await assert.rejects(controlDrawing(cad, { request, expectedContext: base }), /공간 기준|지원하는 CAD/);
    assert.equal(calls.some(call => call.protocol === 1), false);
  }
});

test('anchored drawings permit creation commands but refuse unbounded command edits', async () => {
  const creation = engine({ anchored: true });
  await controlDrawing(creation.cad, { request: { op: 'run', cmd: 'CIRCLE 0,0 4' }, expectedContext: creation.base });
  const modification = engine({ anchored: true });
  await assert.rejects(controlDrawing(modification.cad, { request: { op: 'run', cmd: 'MOVE ALL 0,0 1,1' }, expectedContext: modification.base }));
});

test('incomplete own command returns its prompt; concurrent user command is preserved', async () => {
  const owned = engine({ incomplete: true });
  const reply = await controlDrawing(owned.cad, { request: { op: 'run', cmd: 'LINE 0,0' }, expectedContext: owned.base });
  assert.equal(reply.status, 'waiting_input');
  assert.deepEqual(reply.command.accepts, ['point']);
  assert.equal(owned.calls.some(call => call.op === 'cancel'), false);
  const changed = engine({ incomplete: true, changedReply: true });
  await assert.rejects(controlDrawing(changed.cad, { request: { op: 'run', cmd: 'LINE 0,0' }, expectedContext: changed.base }), /상태가 변경/);
  assert.equal(changed.calls.some(call => call.op === 'cancel'), false);
});

test('native delayed command event is allowed in a reply but not between owned input steps', async () => {
  const value=engine({incomplete:true,replyEvent:true});
  const first=await controlDrawing(value.cad,{request:{op:'start',cmd:'LINE'},expectedContext:value.base});
  assert.equal(first.status,'waiting_input');
  const state=await value.cad.snapshot();
  value.setState({event_cursor:state.event_cursor+1});
  await assert.rejects(controlDrawing(value.cad,{request:{op:'input',kind:'point',point:[0,0,0]},expectedContext:{...value.base,revision:state.revision,geometryRevision:state.geometry_revision}}));
});

test('interactive native dimension is continued from the exact owned state and can finish or cancel', async () => {
  for (const finish of ['input', 'cancel']) {
    const value = engine({ incomplete: true });
    const started = await controlDrawing(value.cad, { request: { op: 'start', cmd: 'DIMLINEAR' }, expectedContext: value.base });
    assert.equal(started.status, 'waiting_input');
    const state = await value.cad.snapshot();
    value.cad.iframe.contentWindow.ocsControl.request = async request => {
      value.calls.push(request);
      value.setState({ command: null, revision: state.revision + 1 });
      return { ok: true, status: finish === 'cancel' ? 'cancelled' : 'completed', state: await value.cad.snapshot() };
    };
    const expectedContext = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision };
    const request = finish === 'cancel' ? { op: 'cancel' } : { op: 'input', kind: 'point', point: [100, 0, 0] };
    const result = await controlDrawing(value.cad, { request, expectedContext });
    assert.equal(result.status, finish === 'cancel' ? 'cancelled' : 'completed');
    assert.equal(result.command, null);
  }
});

test('fresh context cannot adopt a manually changed command or start over an owned one', async () => {
  for (const change of [{ revision: 10 }, { geometry_revision: 10 }, { selection: ['A'] }, { command: { name: 'LINE', accepts: ['enter'] } }, { event_cursor: 10 }]) {
    const value = engine({ incomplete: true });
    await controlDrawing(value.cad, { request: { op: 'start', cmd: 'LINE' }, expectedContext: value.base });
    value.setState(change);
    const state = await value.cad.snapshot();
    const context = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision, selection: state.selection };
    const count = value.calls.filter(call => call.protocol === 1).length;
    await assert.rejects(controlDrawing(value.cad, { request: { op: 'input', kind: 'point', point: [1, 2, 0] }, expectedContext: context }));
    await assert.rejects(controlDrawing(value.cad, { request: { op: 'cancel' }, expectedContext: context }));
    assert.equal(value.calls.filter(call => call.protocol === 1).length, count);
  }
  const value = engine({ incomplete: true });
  await controlDrawing(value.cad, { request: { op: 'start', cmd: 'LINE' }, expectedContext: value.base });
  const state = await value.cad.snapshot();
  await assert.rejects(controlDrawing(value.cad, { request: { op: 'start', cmd: 'CIRCLE' }, expectedContext: { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision } }));
});

test('input accepts only the command advertised input kind and token options', async () => {
  const value = engine({ incomplete: true });
  await controlDrawing(value.cad, { request: { op: 'start', cmd: 'LINE' }, expectedContext: value.base });
  const state = await value.cad.snapshot();
  const context = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision };
  await assert.rejects(controlDrawing(value.cad, { request: { op: 'input', kind: 'text', text: 'SAVE' }, expectedContext: context }));
  await assert.rejects(controlDrawing(value.cad, { request: { op: 'input', kind: 'token', text: 'SAVE' }, expectedContext: context }));
});

test('selection continuation selects guarded real handles before native selection consumes them', async () => {
  for (const handles of [['A', 'B'], []]) {
    const value = engine({ incomplete: true, command: { name: '-BLOCK', accepts: ['selection', 'enter'] } });
    await controlDrawing(value.cad, { request: { op: 'start', cmd: '-BLOCK' }, expectedContext: value.base });
    const state = await value.cad.snapshot();
    const expectedContext = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision };
    const result = await controlDrawing(value.cad, { request: { op: 'input', kind: 'selection', handles }, expectedContext });
    assert.equal(result.status, 'waiting_input');
    const writes = value.calls.filter(call => call.protocol === 1);
    const selected = writes.at(-2);
    const fed = writes.at(-1);
    assert.equal(selected.op, 'select');
    if (handles.length) assert.deepEqual(selected.handles, handles);
    else assert.equal(selected.clear, true);
    assert.equal(fed.op, 'input');
    assert.equal(fed.kind, 'selection');
    assert.equal(Object.hasOwn(fed, 'handles'), false);
    assert.deepEqual(fed.selection, handles);
    assert.equal(fed.revision, selected.revision + 1);
    assert.equal(fed.geometry_revision, selected.geometry_revision + 1);
  }
});

test('selection continuation refuses protected handles before changing editor selection', async () => {
  const value = engine({ incomplete: true, command: { name: '-BLOCK', accepts: ['selection'] } });
  await controlDrawing(value.cad, { request: { op: 'start', cmd: '-BLOCK' }, expectedContext: value.base });
  const state = await value.cad.snapshot();
  const expectedContext = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision };
  const before = value.calls.filter(call => call.protocol === 1).length;
  await assert.rejects(controlDrawing(value.cad, { request: { op: 'input', kind: 'selection', handles: ['FE'] }, expectedContext }), /공간 기준/);
  assert.equal(value.calls.filter(call => call.protocol === 1).length, before);
});

test('token value prompts accept free values only when no keyword options are advertised', async () => {
  for (const [options, text, allowed] of [
    [[], 'VALUE', true], [undefined, 'VALUE', true],
    [[{ keyword: 'HORIZONTAL' }], 'horizontal', true], [['CLOSE'], 'close', true],
    [[{ keyword: 'HORIZONTAL' }], 'VALUE', false], [['CLOSE'], 'SAVE', false],
    [[{ keyword: 'HORIZONTAL' }], '250.5', true],
  ]) {
    const value = engine({ incomplete: true, command: { name: 'DIMLINEAR', accepts: ['token'], ...(options ? { options } : {}) } });
    await controlDrawing(value.cad, { request: { op: 'start', cmd: 'DIMLINEAR' }, expectedContext: value.base });
    const state = await value.cad.snapshot();
    const expectedContext = { ...value.base, revision: state.revision, geometryRevision: state.geometry_revision };
    const work = controlDrawing(value.cad, { request: { op: 'input', kind: 'token', text }, expectedContext });
    if (allowed) assert.equal((await work).status, 'waiting_input');
    else await assert.rejects(work, /옵션 토큰/);
    assert.equal(value.calls.filter(call => call.op === 'input').length, allowed ? 1 : 0);
  }
});

test('active editor commands and failed or stale results are not reported as success', async () => {
  const active = engine(); active.setState({ command: { name: 'LINE' } });
  await assert.rejects(controlDrawing(active.cad, { request: { op: 'undo' }, expectedContext: active.base }), /진행 중/);
  for (const config of [{ replyError: true }, { changedReply: true }]) {
    const { cad, base } = engine(config);
    await assert.rejects(controlDrawing(cad, { request: { op: 'undo' }, expectedContext: base }));
  }
});

test('creation never inherits the protected georeference current layer', async () => {
  const { cad, base, calls } = engine();
  const original = cad.request;
  cad.request = async request => request.op === 'header' ? { ok: true, insertion_units: 4, current_layer: 'SITECAD_GEOREF' } : original(request);
  await assert.rejects(controlDrawing(cad, { request: { op: 'run', cmd: 'CIRCLE 0,0 5' }, expectedContext: base }), /공간 기준/);
  await assert.rejects(controlDrawing(cad, { request: { op: 'entities_create', entities: [{ type: 'Point', location: [0, 0] }] }, expectedContext: base }), /공간 기준/);
  assert.equal(calls.some(call => call.protocol === 1), false);
  await controlDrawing(cad, { request: { op: 'entities_create', entities: [{ type: 'Point', location: [0, 0], layer: 'AI_DRAFT' }] }, expectedContext: base });
});

test('unknown and unsupported drawing units are rejected before any mutation', async () => {
  for (const units of [0,17,24]) {
    const {cad,base,calls}=engine({units});
    await assert.rejects(controlDrawing(cad,{request:{op:'entities_create',entities:[{type:'Point',location:[0,0]}]},expectedContext:base}),/단위/);
    assert.equal(calls.some(call=>call.protocol===1),false);
  }
});


test('associative dimensions are created without external reference regeneration and restore the original setting', async () => {
  const value=engine({dimensionMode:2});
  const result=await controlDrawing(value.cad,{request:{op:'run',cmd:'DIMLINEAR 0,0 6000,0 0,-600'},expectedContext:value.base});
  const writes=value.calls.filter(call=>call.protocol===1);
  assert.deepEqual(writes.map(call=>call.op),['run','run','run']);
  assert.equal(writes[0].cmd,'SETVAR DIMASSOC 1');
  assert.equal(writes[1].geometry_revision,writes[0].geometry_revision+1);
  assert.equal(writes[2].cmd,'SETVAR DIMASSOC 2');
  assert.equal(value.calls.some(call=>call.op==='set_properties'),false);
  assert.equal(value.mode(),2);
  assert.equal(result.status,'completed');
  assert.match(result.details.join(' '),/비연관/);
});

test('dimension compatibility setting survives input steps and is restored after owned cancel', async () => {
  const value=engine({dimensionMode:2,incomplete:true,command:{name:'DIMLINEAR',accepts:['point']}});
  await controlDrawing(value.cad,{request:{op:'start',cmd:'DIMLINEAR'},expectedContext:value.base});
  assert.equal(value.mode(),1);
  const state=await value.cad.snapshot();
  await controlDrawing(value.cad,{request:{op:'input',kind:'point',point:[0,0,0]},expectedContext:{...value.base,revision:state.revision,geometryRevision:state.geometry_revision}});
  assert.equal(value.mode(),1);
  assert.equal((await cancelOwnedCommand(value.cad)).cancelled,true);
  assert.equal(value.mode(),2);
});

test('failed or aborted dimension start restores the setting only while its inactive state is unchanged', async () => {
  for(const failure of ['error','throw','abort']) {
    const value=engine({dimensionMode:2,replyError:failure==='error'});
    const abort=new AbortController();
    const native=value.cad.iframe.contentWindow.ocsControl.request;
    value.cad.iframe.contentWindow.ocsControl.request=async request=>{
      if(request.op==='start' && failure==='throw') throw Error('transport');
      const reply=await native(request);
      if(request.op==='start' && failure==='abort') abort.abort();
      return reply;
    };
    await assert.rejects(controlDrawing(value.cad,{request:{op:'start',cmd:'DIMLINEAR'},expectedContext:value.base},{signal:abort.signal}));
    assert.equal(value.mode(),2);
  }
});

test('user changes during a dimension command prevent both cancellation and overwriting the compatibility setting', async () => {
  const value=engine({dimensionMode:2,incomplete:true,command:{name:'DIMLINEAR',accepts:['point']}});
  await controlDrawing(value.cad,{request:{op:'start',cmd:'DIMLINEAR'},expectedContext:value.base});
  value.setState({selection:['A']});
  await assert.rejects(cancelOwnedCommand(value.cad),/연관.*복원|변경/);
  assert.equal(value.mode(),1);
  assert.equal(value.calls.filter(call=>call.cmd==='SETVAR DIMASSOC 1').length,1);
  assert.equal(value.calls.some(call=>call.cmd==='SETVAR DIMASSOC 2'),false);
  assert.equal(value.calls.some(call=>call.op==='cancel'),false);
});

test('compatibility restore failure is surfaced and dimensions in existing nonassociative modes are unchanged', async () => {
  const value=engine({dimensionMode:2});
  const native=value.cad.iframe.contentWindow.ocsControl.request;
  value.cad.iframe.contentWindow.ocsControl.request=async request=>request.cmd==='SETVAR DIMASSOC 2'?{ok:false,error:'restore denied'}:native(request);
  await assert.rejects(controlDrawing(value.cad,{request:{op:'run',cmd:'DIMLINEAR 0,0 6000,0 0,-600'},expectedContext:value.base}),/복원/);
  for(const dimensionMode of [0,1]) {
    const original=engine({dimensionMode});
    await controlDrawing(original.cad,{request:{op:'start',cmd:'DIMALIGNED'},expectedContext:original.base});
    assert.equal(original.mode(),dimensionMode);
    assert.equal(original.calls.some(call=>call.op==='set_properties'||call.cmd?.startsWith('SETVAR DIMASSOC')),false);
  }
});


test('a failed compatibility restore blocks later commands and can be retried by owned cleanup', async () => {
  const value=engine({dimensionMode:2});
  const native=value.cad.iframe.contentWindow.ocsControl.request;
  value.cad.iframe.contentWindow.ocsControl.request=async request=>request.cmd==='SETVAR DIMASSOC 2'?{ok:false,error:'temporary restore failure'}:native(request);
  await assert.rejects(controlDrawing(value.cad,{request:{op:'run',cmd:'DIMLINEAR 0,0 6000,0 0,-600'},expectedContext:value.base}),/복원/);
  assert.equal(hasPendingCompatibility(value.cad),true);
  const state=await value.cad.snapshot();
  const expectedContext={...value.base,revision:state.revision,geometryRevision:state.geometry_revision};
  const count=value.calls.length;
  await assert.rejects(controlDrawing(value.cad,{request:{op:'run',cmd:'CIRCLE 0,0 10'},expectedContext}),/복원/);
  assert.equal(value.calls.slice(count).some(call=>call.protocol===1),false);
  value.cad.iframe.contentWindow.ocsControl.request=native;
  assert.deepEqual(await cancelOwnedCommand(value.cad),{cancelled:false});
  assert.equal(value.mode(),2);
  assert.equal(hasPendingCompatibility(value.cad),false);
});

test('aborting after the compatibility toggle does not start the dimension and restores the prior mode', async () => {
  const value=engine({dimensionMode:2});
  const abort=new AbortController();
  const native=value.cad.iframe.contentWindow.ocsControl.request;
  value.cad.iframe.contentWindow.ocsControl.request=async request=>{
    const reply=await native(request);
    if(request.cmd==='SETVAR DIMASSOC 1') abort.abort();
    return reply;
  };
  await assert.rejects(controlDrawing(value.cad,{request:{op:'start',cmd:'DIMLINEAR'},expectedContext:value.base},{signal:abort.signal}),/취소/);
  assert.equal(value.calls.some(call=>call.op==='start'),false);
  assert.equal(value.mode(),2);
  assert.equal(hasPendingCompatibility(value.cad),false);
});

test('compatibility setup rejects absent header records, changed state and overridden SETVAR before writing', async () => {
  for(const failure of ['records','changed','alias']) {
    const value=engine({dimensionMode:2});
    const native=value.cad.request;
    value.cad.request=async request=>{
      const result=await native(request);
      if(request.op==='records') {
        if(failure==='records') return {ok:true,records:[]};
        if(failure==='changed') value.setState({revision:10});
      }
      return result;
    };
    if(failure==='alias') value.cad.iframe.contentWindow.localStorage={getItem:()=> 'SETVAR, *ERASE'};
    await assert.rejects(controlDrawing(value.cad,{request:{op:'start',cmd:'DIMLINEAR'},expectedContext:value.base}));
    assert.equal(value.calls.some(call=>call.protocol===1),false);
    assert.equal(value.mode(),2);
  }
});

test('font registration accepts its render invalidation but rejects a concurrent document edit', async t => {
  for (const [font,family,edit,valid] of [
    ['AppleGothic.ttf','AppleGothic',false,true], ['AppleGothic.ttf','AppleGothic',true,false],
    ['malgun.ttf','Malgun Gothic',false,true], ['malgun.ttf','맑은 고딕',false,true],
    ['malgun.ttf','Malgun Gothic',true,false], ['malgun.ttf','Unapproved Font',false,false]
  ]) {
    t.mock.method(globalThis,'fetch',async()=>new Response(new Uint8Array([0,1,0,0]),{headers:{'X-SiteCAD-CAD-Font':font}}));
    const value=engine();const originalRead=value.cad.request;const originalWrite=value.cad.iframe.contentWindow.ocsControl.request;
    value.cad.request=async request=>request.op==='records' && request.collection==='text_styles'
      ? {ok:true,records:[{name:'SiteCAD_KO',handle:'40',properties:{font_file:font,height:0,width_factor:1,big_font_file:''}}]}
      : originalRead(request);
    value.cad.iframe.contentWindow.ocsControl.request=async request=>{
      if(request.op!=='font_register')return originalWrite(request);
      const before=await value.cad.snapshot();
      value.setState({geometry_revision:before.geometry_revision+2,event_cursor:1,...(edit?{revision:before.revision+1}:{})});
      return {ok:true,state:before,result:{file_name:font,family,faces:1}};
    };
    const operation=()=>controlDrawing(value.cad,{request:{op:'entities_create',entities:[{type:'Text',value:'한글',position:[0,0],height:125}]},expectedContext:value.base});
    if(!valid){await assert.rejects(operation(),/변경/);assert.equal(value.calls.some(c=>c.op==='entities_create'),false);}
    else {assert.equal((await operation()).annotation.font,font);const sent=value.calls.find(c=>c.op==='entities_create');assert.equal(sent.geometry_revision,7);assert.equal(sent.entities[0].style,'SiteCAD_KO');}
  }
});
