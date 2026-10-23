import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDesktopCad, startDesktopBridge } from '../public/desktop.js';

test('browser MCP execution delegates to the existing guarded editor and returns actual results', async () => {
  const context = { documentId: 1, revision: 3, units: 4, selection: [], entities: [] };
  const calls = [];
  const cad = { context: async () => context, executePlan: async value => { calls.push(value); return { details: ['created'] }; },
    save: async (name, expected) => { calls.push([name, expected]); return { name, bytes: new TextEncoder().encode('AC1032dwg'), version: 'AC1032', georeferences: [{ version: 1 }] }; } };
  assert.deepEqual(await executeDesktopCad(cad, { method: 'context', payload: {} }), context);
  const operations = [{ type: 'undo' }];
  const result = await executeDesktopCad(cad, { method: 'execute', payload: { operations, expectedContext: context } });
  assert.deepEqual(calls[0], { base: context, operations });
  assert.deepEqual(result.context, context);
  const saved = await executeDesktopCad(cad, { method: 'save', payload: { name: 'sample.dwg', expectedContext: context } });
  assert.equal(Buffer.from(saved.dataBase64, 'base64').toString(), 'AC1032dwg');
  assert.deepEqual(calls[1], ['sample.dwg', context]);
  assert.deepEqual(saved.georeferences, [{ version: 1 }]);
  await assert.rejects(executeDesktopCad(cad, { method: 'exec', payload: {} }), /허용/);
});

test('ending a chat cancels its pending command before returning control to the user', async () => {
  const originalFetch=globalThis.fetch;let resolvePoll;let cleanups=0;
  globalThis.fetch=async()=>new Promise(resolve=>{resolvePoll=resolve;});
  let stop;
  try {
    stop=startDesktopBridge({cancelPendingCommand:async()=>{cleanups++;return {cancelled:true};}}, {isReady:()=>true,onError:error=>{throw error;}});
    assert.deepEqual(await stop.cancel(),{cancelled:true});
    assert.equal(cleanups,1);
  } finally {stop?.();resolvePoll?.({ok:true,json:async()=>({ok:true,data:null})});globalThis.fetch=originalFetch;}
});

test('parcel jobs use captured context and forward cancellation to guarded parcel methods', async () => {
  const expectedContext = { documentId: 1, revision: 3, units: 6, selection: [] };
  const plan = { rings: [], metadata: {}, summary: {} };
  const options = { signal: new AbortController().signal };
  const calls = [];
  const cad = { context: async () => ({ ...expectedContext, revision: 4 }), parcelContext: async (...args) => { calls.push(['context', ...args]); return { georeference: null, context: expectedContext }; },
    insertParcels: async (...args) => { calls.push(['insert', ...args]); return { handles: ['A'], georeference: {}, summary: {} }; } };
  const read = await executeDesktopCad(cad, { method: 'parcel_context', payload: { expectedContext } }, options);
  assert.equal(read.georeference, null);
  const result = await executeDesktopCad(cad, { method: 'insert_parcels', payload: { expectedContext, plan } }, options);
  assert.deepEqual(result.handles, ['A']);
  assert.deepEqual(result.context, { ...expectedContext, revision: 4 });
  assert.deepEqual(calls, [['context', expectedContext, options], ['insert', plan, expectedContext, options]]);
});

test('cancelling a pending bridge poll prevents its late edit from executing', async () => {
  const originalFetch = globalThis.fetch;
  let resolvePoll;
  let calls = 0;
  let stop;
  globalThis.fetch = async () => {
    if (!resolvePoll) return new Promise(resolve => { resolvePoll = resolve; });
    stop();
    return { ok: true, json: async () => ({ ok: true, data: null }) };
  };
  try {
    stop = startDesktopBridge({ executePlan: async () => { calls++; } }, {
      isReady: () => true, onError: error => { throw error; },
    });
    assert.equal(typeof resolvePoll, 'function');
    stop.cancel();
    resolvePoll({ ok: true, json: async () => ({ ok: true, data: {
      id: 'expired', method: 'execute', payload: { operations: [{ type: 'undo' }] },
    } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally { stop?.(); globalThis.fetch = originalFetch; }
});

test('terrain jobs forward guarded context, cancellation and refreshed result context', async () => {
  const base = { documentId: 1, revision: 3, units: 4, selection: [] };
  const refreshed = { ...base, revision: 4 }; const plan = { entities: [] };
  const options = { signal: new AbortController().signal }; let captured;
  const cad = { context: async () => refreshed, insertTerrain: async (...args) => { captured = args; return { handles: ['A'] }; } };
  const reply = await executeDesktopCad(cad, { method: 'insert_terrain', payload: { plan, expectedContext: base } }, options);
  assert.deepEqual(captured, [plan, base, options]); assert.deepEqual(reply, { handles: ['A'], context: refreshed });
});

test('generic discovery, query and control bridge return actual results with refreshed drawing context', async () => {
 const context={documentId:2,revision:4,units:4,selection:[],entities:[]};
 const options={signal:new AbortController().signal};
 for(const method of ['discover','query','control']) {
  const payload={request:{op:method==='discover'?'commands':method==='query'?'measure':'undo'},expectedContext:context};
  let captured;
  const cad={context:async()=>context,[method]:async(...args)=>{captured=args;return {result:{completed:true}};}};
  const result=await executeDesktopCad(cad,{method,payload},options);
  assert.deepEqual(captured,[payload,options]);assert.deepEqual(result,{result:{completed:true},context});
 }
});

test('completion state returns only the actual guarded document and editor status', async () => {
 const calls=[];
 const state={document_id:7,revision:8,geometry_revision:11,layout:'Model',selection:['A'],command:{name:'LINE'},modal:null,text_editor:false,mtext_editor:{active:true},private:'not returned'};
 const cad={snapshot:async()=>structuredClone(state),request:async request=>{calls.push(request);return {insertion_units:6,private:'not returned'};}};
 assert.deepEqual(await executeDesktopCad(cad,{method:'completion_state',payload:{}}),{
  documentId:7,units:6,command:{name:'LINE'},modal:null,textEditor:null,mtextEditor:{active:true},
 });
 assert.deepEqual(calls,[{op:'header'}]);
 const idle={...state,command:undefined,modal:undefined,text_editor:undefined,mtext_editor:undefined};
 cad.snapshot=async()=>idle;
 assert.deepEqual(await executeDesktopCad(cad,{method:'completion_state',payload:{}}),{
  documentId:7,units:6,command:null,modal:null,textEditor:null,mtextEditor:null,
 });
});

test('completion verification fails when the drawing or editor changes during its read', async () => {
 const state={document_id:7,revision:8,geometry_revision:11,layout:'Model',selection:['A'],command:null,modal:null,text_editor:false,mtext_editor:false};
 for(const change of [{document_id:9},{revision:9},{geometry_revision:12},{layout:'Layout1'},{selection:['B']},{command:{name:'LINE'}},{modal:'Dialog'},{text_editor:true},{mtext_editor:true}]) {
  let reads=0;
  const cad={snapshot:async()=>({...state,...(reads++?change:{})}),request:async()=>({insertion_units:4})};
  await assert.rejects(executeDesktopCad(cad,{method:'completion_state',payload:{}}),/작업 완료 확인.*변경/);
 }
});

test('the next turn can execute a valid job delivered to the preceding idle poll', async () => {
 const originalFetch=globalThis.fetch;let resolvePoll;let stop;let writes=0;const paths=[];
 globalThis.fetch=async(path)=>{
  paths.push(path);
  if(path.endsWith('/cad/poll')) return new Promise(resolve=>{resolvePoll=resolve;});
  if(path.endsWith('/cad/claim')) return {ok:true,json:async()=>({ok:true,data:{valid:true}})};
  if(path.endsWith('/cad/result')) {stop();return {ok:true,json:async()=>({ok:true,data:null})};}
  throw Error('unexpected');
 };
 try {
  stop=startDesktopBridge({context:async()=>({}),executePlan:async()=>{writes++;return {details:[]};}}, {isReady:()=>true,onError:error=>{throw error;}});
  stop.cancel();
  resolvePoll({ok:true,json:async()=>({ok:true,data:{id:'new-turn-job',method:'execute',payload:{expectedContext:{},operations:[{type:'undo'}]}}})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,1);assert(paths.some(path=>path.endsWith('/cad/claim')));
 }finally{stop?.();globalThis.fetch=originalFetch;}
});

for (const scenario of ['expired', 'cancelled during claim']) {
 test(`a job ${scenario} is never executed`, async () => {
  const originalFetch=globalThis.fetch;let resolvePoll;let resolveClaim;let stop;let writes=0;
  globalThis.fetch=async(path)=>{
   if(path.endsWith('/cad/poll')) return new Promise(resolve=>{resolvePoll=resolve;});
   if(path.endsWith('/cad/claim')) return new Promise(resolve=>{resolveClaim=resolve;});
   throw Error('expired jobs must not be posted');
  };
  try {
   stop=startDesktopBridge({executePlan:async()=>{writes++;}}, {isReady:()=>true,onError:error=>{throw error;}});
   resolvePoll({ok:true,json:async()=>({ok:true,data:{id:'pending',method:'execute',payload:{operations:[{type:'undo'}]}}})});
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(typeof resolveClaim,'function');
   if(scenario==='cancelled during claim') stop.cancel();
   resolveClaim({ok:true,json:async()=>({ok:true,data:{valid:scenario!=='expired'}})});
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(writes,0);
  }finally{stop?.();globalThis.fetch=originalFetch;}
 });
}
