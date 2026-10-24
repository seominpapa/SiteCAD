import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpHandler, createBridgeClient, mcpTools, serveMcp } from '../lib/sitecad-mcp.mjs';
import { researchTools } from '../lib/research-mcp.mjs';

test('research MCP schemas dispatch to the backend without requiring a CAD write context', async () => {
  const calls = [];
  const handle = createMcpHandler(async (method, args) => { calls.push([method, args]); return { source: true }; }, researchTools);
  assert.equal((await handle('tools/list')).tools.length, 20);
  assert.equal((await handle('tools/call', { name: 'cad_fetch', arguments: { url: 'https://example.org' } })).structuredContent.source, true);
  await handle('tools/call', { name: 'cad_design_note', arguments: { title: 'test' } });
  await handle('tools/call', { name: 'cad_vworld_geocode', arguments: { address: '서울 중구' } });
  await handle('tools/call', { name: 'cad_vworld_parcels', arguments: { bbox: [126.9, 37.5, 126.901, 37.501] } });
  await handle('tools/call', { name: 'cad_terrain_sources', arguments: {} });
  await handle('tools/call', { name: 'cad_terrain_query', arguments: { bbox: [126.9, 37.5, 126.901, 37.501] } });
  assert.deepEqual(calls.map(([method]) => method), ['fetch', 'design', 'geocode', 'parcels', 'terrain_sources', 'terrain_query']);
});

const context = { documentId: 1, revision: 2, units: 4, selection: [], entities: [] };
test('MCP exposes drawing tools and binds edits to fresh context', async () => {
  const calls = [];
  const handle = createMcpHandler(async (method, payload) => { calls.push({ method, payload }); return method === 'context' ? context : { success: true }; });
  assert.deepEqual((await handle('tools/list', {})).tools.map(t => t.name), ['cad_context', 'cad_execute', 'cad_save', 'cad_insert_parcels', 'cad_insert_terrain','sitecad_mcp','sitecad_skills', 'cad_prepare_site', 'cad_discover', 'cad_query', 'cad_control', 'cad_download', 'cad_calculate', 'cad_terrain_register']);
  const operations = [{ type: 'line', x1_mm: 0, y1_mm: 0, x2_mm: 10, y2_mm: 0 }];
  assert.equal((await handle('tools/call', { name: 'cad_execute', arguments: { operations } })).isError, undefined);
  assert.deepEqual(calls.map(c => c.method), ['context', 'execute']);
  assert.deepEqual(calls[1].payload.expectedContext, { documentId: 1, revision: 2, units: 4, selection: [] });
  await handle('tools/call', { name: 'cad_save', arguments: { name: 'example.dwg' } });
  assert.deepEqual(calls.map(c => c.method), ['context', 'execute', 'context', 'save']);
  assert.equal(mcpTools[0].annotations.readOnlyHint, true);
});
test('MCP refuses unsupported operations, oversized plans, path traversal and extra arguments', async () => {
  const handle = createMcpHandler(async () => { throw Error('must not reach bridge'); });
  for (const arguments_ of [{ operations: [{ type: 'exec' }] }, { operations: Array(9).fill({ type: 'undo' }) }, { operations: [], extra: true }]) {
    assert.equal((await handle('tools/call', { name: 'cad_execute', arguments: arguments_ })).isError, true);
  }
  for (const name of ['../private.dwg', '/tmp/file.dwg', 'a\\b.dwg', 'test.txt', '.dwg']) {
    assert.equal((await handle('tools/call', { name: 'cad_save', arguments: { name } })).isError, true);
  }
  assert.equal((await handle('tools/call', { name: 'shell', arguments: {} })).isError, true);
  assert.equal((await handle('tools/call', { name: 42, arguments: {} })).isError, true);
});
test('MCP bridge is authenticated loopback only and hides private response errors', async () => {
  for (const url of ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://user:pass@127.0.0.1:1']) {
    assert.throws(() => createBridgeClient({ bridgeUrl: url, bridgeToken: 'x'.repeat(32) }));
  }
  let request;
  const client = createBridgeClient({ bridgeUrl: 'http://127.0.0.1:1234', bridgeToken: 'x'.repeat(32), fetchImpl: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ ok: true, data: context }));
  } });
  assert.deepEqual(await client('context', {}), context);
  assert.equal(request.options.headers.Authorization, `Bearer ${'x'.repeat(32)}`);
  assert.equal(request.options.redirect, 'error');
  const handle = createMcpHandler(async () => { throw Error('ACCESS_TOKEN=private'); });
  const result = await handle('tools/call', { name: 'cad_context', arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private|ACCESS_TOKEN/);
});
test('MCP stdio negotiates protocol, handles notifications, and rejects invalid JSON without leaking data', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  serveMcp({ input, output, bridge: async () => context });
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cad_context', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'unknown' },
  ]) input.write(`${JSON.stringify(request)}\n`);
  input.write('bad-private\n');
  await new Promise(resolve => setImmediate(resolve));
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 5);
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.equal(responses[1].result.structuredContent.documentId, 1);
  assert.deepEqual(responses[2].result, {});
  assert.equal(responses[3].error.code, -32600);
  assert.doesNotMatch(text, /bad-private/);
  input.destroy(); output.destroy();
});
test('MCP bridge rejects errors and oversized output; input line and queue limits close transport', async () => {
  for (const response of [new Response('private', { status: 401 }), new Response('{"ok":false,"error":"private"}'), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const client = createBridgeClient({ bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'x'.repeat(32), fetchImpl: async () => response });
    await assert.rejects(client('context', {}));
  }
  for (const data of ['x'.repeat(1024 * 1024 + 1), Array.from({ length: 17 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n']) {
    const input = new PassThrough(); const output = new PassThrough(); output.resume();
    serveMcp({ input, output, bridge: async () => context }); input.write(data);
    assert.equal(input.destroyed, true); output.destroy();
  }
});


test('parcel insertion sends only a retrieved source id and bounded optional millimetre placement', async () => {
 for (const tool of ['cad_insert_parcels', 'cad_insert_terrain']) {
  const calls = [];
  const handle = createMcpHandler(async (method, payload) => { calls.push({ method, payload }); return method === 'context' ? context : { inserted: true }; });
  const result = await handle('tools/call', { name: tool, arguments: { sourceId: 'geo-123', x_mm: 0 } });
  assert.equal(result.structuredContent.inserted, true);
  assert.deepEqual(calls.map(item => item.method), ['context', tool === 'cad_insert_parcels' ? 'insert_parcels' : 'insert_terrain']);
  assert.equal(calls[1].payload.x_mm, 0);
  assert.equal(Object.hasOwn(calls[1].payload, 'y_mm'), false);
  for (const args of [{ sourceId: 'x', geometry: [] }, { sourceId: 'x', x_mm: Infinity }, { sourceId: 'x', y_mm: 1e9 }, {}, { sourceId: '' }]) {
    assert.equal((await handle('tools/call', { name: tool, arguments: args })).isError, true);
  }
  assert.equal(calls.length, 2);
 }
});

test('generic tools separate discovery from guarded requests and expose utilities', async () => {
  const calls=[];
  const handle=createMcpHandler(async (method,payload)=>{ calls.push({method,payload}); return method==='context'?context:{done:true}; });
  for (const [name,args] of [['cad_discover',{request:{op:'commands',search:'ARC'}}],['cad_query',{request:{op:'measure',handles:['A']}}],['cad_control',{request:{op:'entities_transform',handles:['A'],action:'rotate',center:[0,0],angle_deg:90}}],['cad_calculate',{expressions:[{name:'area',expression:'3*4'}]}],['cad_download',{url:'https://example.org/source.dxf'}]]) {
    assert.equal((await handle('tools/call',{name,arguments:args})).structuredContent?.done,true,name);
  }
  assert.deepEqual(calls.map(call=>call.method),['discover','context','query','context','control','calculate','download']);
  assert.equal(calls[4].payload.expectedContext.revision,2);
  assert.equal((await handle('tools/call',{name:'cad_control',arguments:{request:{op:'save'}}})).isError,true);
});

test('generic mutation errors preserve inspect-before-retry warning without native error leakage', async () => {
 const handle=createMcpHandler(async method=>{if(method==='context') return context; throw Error('private-token');});
 const reply=await handle('tools/call',{name:'cad_control',arguments:{request:{op:'run',cmd:'LINE 0,0'}}});
 assert.equal(reply.isError,true); assert.match(reply.content[0].text,/일부 객체.*반영/); assert.match(reply.content[0].text,/반복하지/); assert.doesNotMatch(JSON.stringify(reply),/private-token/);
});

test('MCP advertises interactive commands and forwards each step with a fresh drawing context', async () => {
  const calls=[];
  const revisions=[2,3,4,5];
  const command={name:'DIMLINEAR',prompt:'First point',accepts:['point']};
  const handle=createMcpHandler(async (method,payload)=>{
    calls.push({method,payload});
    return method==='context'?{...context,revision:revisions.shift(),geometryRevision:9,layout:'Model',command}:{waiting:method==='control'};
  });
  const tools=(await handle('tools/list',{})).tools;
  const control=tools.find(tool=>tool.name==='cad_control');
  for (const op of ['start','input','cancel','run']) assert.ok(control.inputSchema.properties.request.properties.op.enum.includes(op),op);
  for (const request of [
    {op:'start',cmd:'DIMLINEAR'},
    {op:'input',kind:'point',point:[0,0,0],space:'wcs'},
    {op:'input',kind:'enter'},
    {op:'cancel'},
  ]) {
    const reply=await handle('tools/call',{name:'cad_control',arguments:{request}});
    assert.equal(reply.isError,undefined,JSON.stringify(request));
    assert.deepEqual(calls.at(-1).payload.request,request);
  }
  assert.deepEqual(calls.map(call=>call.method),['context','control','context','control','context','control','context','control']);
  assert.deepEqual(calls.filter(call=>call.method==='control').map(call=>call.payload.expectedContext),
    [2,3,4,5].map(revision=>({documentId:1,revision,units:4,selection:[],geometryRevision:9,layout:'Model',command})));
});

test('MCP rejects unsafe interactive input before reading or editing the drawing', async () => {
  const calls=[];
  const handle=createMcpHandler(async (method,payload)=>{calls.push({method,payload});return context;});
  for (const request of [
    {op:'start',cmd:'SAVE'},
    {op:'start',cmd:'LINE',expectedContext:{documentId:99}},
    {op:'input',kind:'point',point:[0,NaN,0],space:'wcs'},
    {op:'input',kind:'enter',revision:2},
    {op:'cancel',cmd:'SAVE'},
  ]) assert.equal((await handle('tools/call',{name:'cad_control',arguments:{request}})).isError,true,JSON.stringify(request));
  assert.deepEqual(calls,[]);
});

test('terrain registration accepts only a download ID and never accepts a model supplied path', async () => {
  const calls = [], downloadId = 'cfe66a1c-8a45-4dab-aed6-c294ec2fbd5f';
  const handle = createMcpHandler(async (method, payload) => { calls.push({ method, payload }); return { id: 'terrain-registered' }; });
  const result = await handle('tools/call', { name: 'cad_terrain_register', arguments: { downloadId } });
  assert.equal(result.structuredContent?.id, 'terrain-registered');
  assert.deepEqual(calls, [{ method: 'terrain_register', payload: { downloadId } }]);
  for (const args of [{}, { downloadId: '' }, { downloadId: '../file' }, { downloadId, path: '/private/secret.geojson' }, { downloadId: 5 }]) {
    assert.equal((await handle('tools/call', { name: 'cad_terrain_register', arguments: args })).isError, true);
  }
  assert.equal(calls.length, 1);
  const failed = createMcpHandler(async () => { throw Error('private-file-path'); });
  const error = await failed('tools/call', { name: 'cad_terrain_register', arguments: { downloadId } });
  assert.match(error.content[0].text, /현재.*다운로드.*GeoJSON/);
  assert.doesNotMatch(JSON.stringify(error), /private-file-path/);
});


test('existing generic MCP tools advertise native 2D operations and forward them with context guards', async () => {
  const calls=[];
  const handler=createMcpHandler(async (method,payload)=>{calls.push({method,payload});return method==='context'?context:{ok:true};});
  const tools=(await handler('tools/list')).tools;
  assert.equal(tools.length,mcpTools.length);
  const schema=name=>tools.find(tool=>tool.name===name).inputSchema.properties.request.properties.op.enum;
  assert.ok(schema('cad_query').includes('sysvar'));
  for (const op of ['set_properties','block_define','block_delete','layout_create','page_setup_set','action','sysvar']) assert.ok(schema('cad_control').includes(op),op);
  for (const [tool,request] of [
    ['cad_discover',{op:'record_schema',collection:'layers'}],
    ['cad_query',{op:'records',collection:'layers',name:'벽체',paths:['/color']}],
    ['cad_query',{op:'sysvar',get:['CLAYER','insunits']}],
    ['cad_control',{op:'set_properties',collection:'entities',handle:'A',updates:[{path:'/common/layer',value:'벽체',expected:'0'}]}],
    ['cad_control',{op:'block_define',name:'기둥',base:[0,0],handles:['A']}],
    ['cad_control',{op:'block_delete',name:'기둥'}],
    ['cad_control',{op:'layout_create',name:'배치'}],
    ['cad_control',{op:'action',name:'layout_switch',value:'배치'}],
    ['cad_control',{op:'page_setup_set',layout:'배치',paper:'A4',scale:'1:100'}],
    ['cad_control',{op:'sysvar',set:{ltscale:100}}],
  ]) {
    const result=await handler('tools/call',{name:tool,arguments:{request}});
    assert.equal(result.isError,undefined,JSON.stringify(request));
    assert.deepEqual(calls.at(-1).payload.request,request);
    if (tool!=='cad_discover') assert.deepEqual(calls.at(-1).payload.expectedContext,{documentId:context.documentId,revision:context.revision,units:context.units,selection:context.selection});
  }
});

test('the same generic MCP tools expose native 3D discovery, execution and measurement', async () => {
  const calls=[];
  const handler=createMcpHandler(async(method,payload)=>{calls.push({method,payload});return method==='context'?context:{ok:true};});
  const tools=(await handler('tools/list')).tools;
  assert.deepEqual(tools.map(tool=>tool.name),mcpTools.map(tool=>tool.name));
  assert.match(tools.find(tool=>tool.name==='cad_control').description,/3D/);
  assert.match(tools.find(tool=>tool.name==='cad_query').description,/volume/);
  const queryDescription=tools.find(tool=>tool.name==='cad_query').description;
  assert.match(queryDescription,/tessellat.*approximat|approximat.*tessellat/i);
  assert.match(queryDescription,/reopen.*(?:change|differ)|(?:change|differ).*reopen/i);
  assert.match(queryDescription,/zero.*bounds.*(?:unknown|unsupported|unavailable).*not.*point/i);
  for(const [tool,request] of [['cad_discover',{op:'commands',name:'3DPOLY'}],['cad_control',{op:'start',cmd:'3DPOLY'}],['cad_control',{op:'input',kind:'point',point:[10,20,300],space:'wcs'}],['cad_query',{op:'measure',handles:['A']}]] ) {
    const reply=await handler('tools/call',{name:tool,arguments:{request}});
    assert.equal(reply.isError,undefined,JSON.stringify(request));
    assert.deepEqual(calls.at(-1).payload.request,request);
    if(tool!=='cad_discover') assert.deepEqual(calls.at(-1).payload.expectedContext,{documentId:1,revision:2,units:4,selection:[]});
  }
});
