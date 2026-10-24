import test from 'node:test';
import assert from 'node:assert/strict';
import { METADATA_PREFIX } from '../public/geo-reference.js';
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

test('3D work uses native commands and XYZ input without claiming unsupported typed solid creation', async () => {
  for(const request of [{op:'start',cmd:'3DPOLY'},{op:'run',cmd:'3DFACE 0,0,10 100,0,20 100,100,30 0,100,40'},{op:'start',cmd:'EXTRUDE'},{op:'input',kind:'point',point:[10,20,300],space:'wcs'},{op:'run',cmd:'VIEW SWISO'},{op:'run',cmd:'VISUALSTYLES HIDDENLINE'}]) {
    assert.deepEqual(validateControlRequest(request),request);
  }
  for (const type of ['Solid3D','Mesh','Face3D']) assert.throws(()=>validateControlRequest({op:'entities_create',entities:[{type}]}),type);
  for(const request of [{op:'start',cmd:'VIEW'},{op:'start',cmd:'VISUALSTYLES'},{op:'run',cmd:'VIEW DIALOG'},{op:'run',cmd:'VIEW  SWISO'},{op:'run',cmd:'VIEW\tSWISO'},{op:'run',cmd:'VISUALSTYLES private'}]) assert.throws(()=>validateControlRequest(request),JSON.stringify(request));
  const {controlSchemas}=await import('../public/control-schema.js');
  assert.match(JSON.stringify(controlSchemas),/Solid3D/);
  assert.match(JSON.stringify(controlSchemas),/3DPOLY/);
  assert.match(controlSchemas.modelingNote,/tessellat.*approximat|approximat.*tessellat/i);
  assert.match(controlSchemas.modelingNote,/reopen.*(?:change|differ)|(?:change|differ).*reopen/i);
  assert.match(controlSchemas.modelingNote,/zero.*bounds.*(?:unknown|unsupported|unavailable).*not.*point/i);
});


test('generic record discovery and queries preserve native filters and projection', () => {
  for (const request of [
    {op:'record_schema',collection:'layers',search:'Layer',limit:10},
    {op:'record_schema',collection:'entities',type:'Line'},
  ]) assert.deepEqual(validateDiscoverRequest(request),request);
  for (const request of [
    {op:'records',collection:'layers',name:'벽체 레이어',paths:['/name','/color'],where:[{path:'/color',op:'eq',value:7}]},
    {op:'records',collection:'entities',handle:'A',type:'Line',detail:'full',limit:20},
    {op:'sysvar',get:['CLAYER','insunits','extmin']},
  ]) assert.deepEqual(validateQueryRequest(request),request);
  for (const request of [
    {op:'records',paths:['/__proto__/polluted']},
    {op:'records',paths:['/constructor']},
    {op:'records',handle:'../a'},
    {op:'sysvar',get:['PRIVATE_PATH']},
    {op:'sysvar',get:['clayer'],set:{clayer:'x'}},
  ]) assert.throws(()=>validateQueryRequest(request),JSON.stringify(request));
});

test('generic native mutations accept CAS property edits, blocks, sheets, safe variables and Korean tokens', () => {
  for (const request of [
    {op:'set_properties',collection:'entities',handle:'A',updates:[{path:'/start',expected:{x:0,y:0,z:0},value:{x:10,y:20,z:0}}]},
    {op:'set_properties',collection:'entities',handle:'B',updates:[{path:'/common/layer',expected:'0',value:'벽체 레이어'},{path:'/value',expected:'Before',value:'수정 주석'}]},
    {op:'set_properties',collection:'layers',name:'벽체 레이어',updates:[{path:'/color',expected:7,value:3}]},
    {op:'set_properties',collection:'text_styles',name:'표준',updates:[{path:'/font_file',expected:'',value:'malgun.ttf'}]},
    {op:'block_define',name:'기둥 01',base:[0,0,0],handles:['A','B'],insert_at:[10,0,0],replace:true},
    {op:'block_delete',name:'기둥 01',force:true},
    {op:'layout_create',name:'배치 01'},
    {op:'action',name:'layout_switch',value:'배치 01'},
    {op:'page_setup_set',layout:'배치 01',paper:'ISO_A4_(210.00_x_297.00_MM)',orientation:'landscape',scale:'1:100',fit:false,center:true,window:[0,0,200,300],plot_style:'monochrome.ctb'},
    {op:'sysvar',set:{clayer:'벽체 레이어',ctextstyle:'표준',ltscale:100,celtscale:1,textsize:250,filletrad:0,pdmode:3,pdsize:-1,mirrtext:0,osmode:16383}},
    {op:'run',cmd:'-LAYER M 벽체 C 8 벽체'},
    {op:'input',kind:'token',text:'벽체 레이어'},
    {op:'input',kind:'token',text:'1층'},
    {op:'run',cmd:'-LAYER M 1층'},
    {op:'layout_create',name:'배치 (1층)'},
  ]) assert.deepEqual(validateControlRequest(request),request);
});

test('generic mutation boundary rejects identity, metadata, structural replacement and unsafe selectors', () => {
  const edit=(path,value,expected=0)=>({op:'set_properties',collection:'entities',handle:'A',updates:[{path,value,expected}]});
  for (const request of [
    {...edit('/radius',5),updates:[{path:'/radius',value:5}]},
    {...edit('/radius',5),name:'Other'},
    {...edit('/radius',5),handles:['A']},
    {...edit('/radius',5),collection:'header'},
    {...edit('/radius',5),collection:'objects'},
    {...edit('/radius',5),collection:'block_records'},
    {...edit('/radius',5),handle:undefined,name:'LINE'},
    edit('/common',{layer:'NEW',handle:'C'}),
    edit('/common/handle','C'),
    edit('/owner_handle','C'),
    edit('/text_style_handle','C'),
    edit('/common/reactors',['C']),
    edit('/xdata',[]),
    edit('/attributes',[{value:METADATA_PREFIX+'payload'}]),
    edit('/block_name','Other'),
    edit('/__proto__/polluted',true),
    edit('/constructor/prototype/a',true),
    edit('/common/layer','SITE_GEOREFERENCE'),
    edit('/value',METADATA_PREFIX+'payload'),
    edit('/radius',Infinity),
    edit('/radius',1e9),
    {...edit('/name','New'),collection:'layers'},
    {op:'set_properties',collection:'layers',name:'SITE_GEOREFERENCE',updates:[{path:'/color',value:1,expected:7}]},
    {op:'block_define',name:'*Model_Space',base:[0,0],handles:['A']},
    {op:'block_define',name:'../outside',base:[0,0],handles:['A']},
    {op:'block_define',name:'B',base:[0,0],handles:[]},
    {op:'block_delete',name:'B',force:'yes'},
    {op:'action',name:'open',value:'x.dwg'},
    {op:'layout_create',name:'Model/../other'},
    {op:'page_setup_set',layout:'배치',plot_style:'../x.ctb'},
    {op:'page_setup_set',layout:'배치',orientation:'portrait'},
    {op:'page_setup_set',layout:'배치',scale:'1:0'},
    {op:'page_setup_set',layout:'배치',scale:'1:Infinity'},
    {op:'page_setup_set',layout:'배치',window:[10,10,0,0]},
    {op:'sysvar',get:['clayer']},
    {op:'sysvar',set:{}},
    {op:'sysvar',set:{insunits:6}},
    {op:'sysvar',set:{clayer:'SITE_GEOREFERENCE'}},
    {op:'sysvar',set:{ltscale:0}},
    {op:'sysvar',set:{mirrtext:2}},
    {op:'sysvar',set:{osmode:1.5}},
    {op:'input',kind:'token',text:'벽체;SAVE'},
    {op:'input',kind:'token',text:'../벽체'},
  ]) assert.throws(()=>validateControlRequest(request),JSON.stringify(request));
});


test('generic property JSON remains bounded and cannot smuggle nested references or metadata', () => {
  const edit=(value,expected=0,path='/start')=>({op:'set_properties',collection:'entities',handle:'A',updates:[{path,value,expected}]});
  for (const request of [
    edit({x:1,y:2,z:3}), edit([1,2,3]), edit('', 'Prior', '/value'),
  ]) assert.deepEqual(validateControlRequest(request),request);
  for (const request of [
    edit({x:Infinity,y:0}), edit({x:{owner_handle:4}}), edit([1,2,'text']),
    edit({value:METADATA_PREFIX+'payload'}), edit(JSON.parse('{"__proto__":{"x":1}}')),
    {...edit(1),updates:[{path:'/start',value:1,expected:undefined}]}, edit(1,0,'/bad~2path'), edit(Array(1001).fill(1)),
    edit({x:{x:{x:{x:{x:{x:{x:{x:{x:{x:1}}}}}}}}}}),
  ]) assert.throws(()=>validateControlRequest(request),JSON.stringify(request));
});
