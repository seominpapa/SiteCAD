import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoverRequest, validateQueryRequest, validateControlRequest } from '../public/control-schema.js';
test('CAD requests accept bounded documented search, geometry, measurements and transforms', () => {
  for (const request of [{op:'capabilities'}, {op:'commands',search:'LINE',limit:20}, {op:'commands',name:'PLINE'}, {op:'record_schema',type:'Arc'}]) assert.deepEqual(validateDiscoverRequest(request), request);
  for (const request of [{op:'query',layer:'WALL',limit:100,bounds:[0,0,5000,5000]}, {op:'measure',handles:['A','B']}, {op:'properties',handles:['A']}, {op:'layers'}, {op:'query',where:[{path:'/radius',op:'gt',value:20}]}]) assert.deepEqual(validateQueryRequest(request), request);
  for (const request of [{op:'entities_create',entities:[{type:'Arc',center:[0,0,0],radius:10,start_angle_deg:0,end_angle_deg:90,layer:'AI_DRAFT'}]}, {op:'entities_transform',handles:['A'],action:'rotate',center:[0,0],angle_deg:90}, {op:'select',handles:['A']}, {op:'run',cmd:'LINE 0,0 100,0 '}, {op:'undo'}]) assert.deepEqual(validateControlRequest(request), request);
});
test('CAD trust boundary rejects lifecycle, envelope spoofing, command injection and oversized geometry', () => {
  for (const request of [{op:'save'}, {op:'open',path:'/tmp/x.dwg'}, {op:'sysvar',set:{insunits:6}}, {op:'entities_delete',handles:['A'],revision:1}, {op:'run',cmd:'SAVE x.dwg'}, {op:'run',cmd:'LINE 0,0 1,1\nSAVE x.dwg'}, {op:'entities_create',entities:[{type:'Text',position:[0,0],value:'x',layer:'SITE_GEOREFERENCE'}]}, {op:'entities_create',entities:[{type:'Circle',center:[0,0],radius:Infinity}]}, {op:'entities_transform',handles:['A'],action:'array',rows:10000,columns:10000,row_spacing:1,column_spacing:1}]) assert.throws(()=>validateControlRequest(request), JSON.stringify(request));
  for (const request of [{op:'query',limit:10001}, {op:'query',handles:Array(501).fill('A')}, {op:'query',path:'private'}, {op:'query',where:[{path:'__proto__',op:'eq',value:1}]}]) assert.throws(()=>validateQueryRequest(request));
  assert.throws(()=>validateDiscoverRequest({op:'record_schema'}));
});

test('discovered creation examples are executable inputs rather than serialized record properties', async () => {
 const { controlSchemas }=await import('../public/control-schema.js');
 assert.equal(controlSchemas.creationInputs.Arc.start_angle_deg,0);
 assert.deepEqual(validateControlRequest(controlSchemas.runExample),{op:'run',cmd:'LINE 0,0,0 100,0,0'});
 for (const [type,fields] of Object.entries(controlSchemas.creationInputs)) assert.doesNotThrow(()=>validateControlRequest({op:'entities_create',entities:[{type,...fields}]}));
});

test('generic commands accept native names and typed follow-up input without a fixed drafting whitelist', () => {
  for (const request of [
    {op:'run',cmd:'DIMLINEAR 0,0 100,0 50,20'},
    {op:'run',cmd:'-LAYER M Site_CAD C 8 Site_CAD'},
    {op:'run',cmd:'CUSTOMCAD'},
    {op:'start',cmd:'DIMLINEAR'},
    {op:'start',cmd:'-LAYER'},
    {op:'cancel'},
    {op:'input',kind:'point',point:[10,20,0],space:'wcs'},
    {op:'input',kind:'point',point:[10,20,0],space:'ucs'},
    {op:'input',kind:'point',point:[10,20,0],space:'relative'},
    {op:'input',kind:'point',point:[10,20,0]},
    {op:'input',kind:'token',text:'Diameter'},
    {op:'input',kind:'text',text:'도면 검토 주석'},
    {op:'input',kind:'selection',handles:['A','B']},
    {op:'input',kind:'selection',handles:[]},
    {op:'input',kind:'entity',handle:'AB',point:[10,20,0]},
    {op:'input',kind:'structure',handle:'AB',point:[10,20,0]},
    {op:'input',kind:'enter'},
  ]) assert.deepEqual(validateControlRequest(request),request);
});

test('interactive command boundary rejects lifecycle, framing injection and malformed follow-up input', () => {
  for (const command of ['SAVE','QSAVE','SAVEAS','OPEN','NEW','CLOSE','QUIT','SYSVAR','INSUNITS','BROWSER','SCRIPT','WBLOCK','EXPORT']) {
    for (const op of ['run','start']) assert.throws(()=>validateControlRequest({op,cmd:command}),`${op}:${command}`);
  }
  for (const request of [
    {op:'start',cmd:'LINE 0,0'},
    {op:'start',cmd:'line'},
    {op:'start',cmd:'_LINE'},
    {op:'start',cmd:'.LINE'},
    {op:'start',cmd:'LINE\nSAVE'},
    {op:'start',cmd:'LINE;SAVE'},
    {op:'start',cmd:'(load "private")'},
    {op:'start',cmd:'LINE',revision:2},
    {op:'cancel',expectedContext:{documentId:1}},
    {op:'input',kind:'enter',cmd:'SAVE'},
    {op:'input',kind:'point',point:[0,Infinity,0],space:'wcs'},
    {op:'input',kind:'point',point:[0,0],space:'wcs'},
    {op:'input',kind:'point',point:[0,0,0],space:'screen'},
    {op:'input',kind:'point',point:[0,0,0],space:'wcs',revision:2},
    {op:'input',kind:'token',value:'Diameter'},
    {op:'input',kind:'token',token:'Diameter'},
    {op:'input',kind:'token',text:'D\nSAVE'},
    {op:'input',kind:'text',text:'x'.repeat(4001)},
    {op:'input',kind:'selection',handles:['not-a-real-handle']},
    {op:'input',kind:'selection',handles:Array.from({length:101},(_,index)=>(index+1).toString(16).toUpperCase())},
    {op:'input',kind:'selection',handles:['A','A']},
    {op:'input',kind:'entity',handle:'../private'},
    {op:'input',kind:'entity',handle:'A'},
    {op:'input',kind:'entity',handle:'A',point:[0,0]},
    {op:'input',kind:'entity',handle:'A',point:[0,0,0],space:'wcs'},
    {op:'input',kind:'structure',handle:'A'},
    {op:'input',kind:'structure',handle:'A',point:[0,0,0],space:'wcs'},
    {op:'run',cmd:'LINE 0,0;SAVE'},
    {op:'run',cmd:'LINE 0,0\rSAVE'},
    {op:'run',cmd:'LINE 0,0\u0000SAVE'},
    {op:'run',cmd:'(load "private")'},
    {op:'run',cmd:'TEXT 0,0 "quoted answer"'},
    {op:'run',cmd:'LINE '+ '0'.repeat(4001)},
    {op:'run',cmd:'-LAYER M SITE_GEOREFERENCE'},
  ]) assert.throws(()=>validateControlRequest(request),JSON.stringify(request));
});
