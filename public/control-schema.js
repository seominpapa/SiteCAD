import { GEO_LAYER, METADATA_PREFIX } from './geo-reference.js';
import { commandName, isBlockedCommand, approvedCommands } from './command-policy.js';

export const DRAW_COMMANDS = Object.freeze(['LINE','PLINE','RECTANG','CIRCLE','ARC','ELLIPSE','SPLINE','POINT','POLYGON','TEXT','MTEXT','HATCH']);
export const EDIT_COMMANDS = Object.freeze(['MOVE','COPY','ROTATE','SCALE','MIRROR','OFFSET','TRIM','EXTEND','FILLET','CHAMFER','EXPLODE','JOIN','BREAK','PEDIT','ERASE','ARRAY']);
const discoverOps = ['capabilities','commands','record_schema'];
const queryOps = ['state','query','properties','measure','layers','header','history','records'];
const controlOps = ['entities_create','entities_delete','entities_transform','select','undo','redo','run','start','input','cancel'];
export const controlSchemas = Object.freeze({ discover: {op:discoverOps}, query:{op:queryOps}, control:{op:controlOps,commands:approvedCommands},
  runExample:{op:'run',cmd:'LINE 0,0,0 100,0,0'},
  runNote:'One native command and bounded answers. Discover SiteCAD access first. waiting_input is not completion: read command.accepts/options/input_example, refresh context, then input or cancel. Use start for unfamiliar commands; no newline, quotes or semicolon.',
  inputExamples:[{op:'start',cmd:'DIMLINEAR'},{op:'input',kind:'point',point:[0,0,0],space:'wcs'},{op:'input',kind:'token',text:'HORIZONTAL'},{op:'input',kind:'text',text:'Example'},{op:'input',kind:'selection',handles:['A']},{op:'input',kind:'entity',handle:'A',point:[0,0,0]},{op:'input',kind:'enter'},{op:'cancel'}],
  creationNote:'entities_create uses these flat typed inputs in drawing units, not serialized record properties. Replace example values. Optional common layer/color. Text/MText: omit height/style for automatic readable size and Korean font; explicit height/style are preserved. New dimensions receive a dedicated automatic scale style. Insert requires an existing block; do not invent block names.',
  creationInputs: {
    Line:{start:[0,0,0],end:[100,0,0]},Circle:{center:[0,0,0],radius:50},
    Arc:{center:[0,0,0],radius:50,start_angle_deg:0,end_angle_deg:90},
    LwPolyline:{vertices:[[0,0,0],[100,0,0],[100,100,0]],closed:true},Point:{location:[0,0,0]},
    Text:{value:'Example',position:[0,0,0],rotation_deg:0},
    MText:{value:'Example',position:[0,0,0],width:100},
    Spline:{control_points:[[0,0,0],[20,30,0],[60,30,0],[100,0,0]],degree:3},
    Solid:{corners:[[0,0,0],[100,0,0],[100,100,0],[0,100,0]]},
    Hatch:{boundary:[[0,0,0],[100,0,0],[100,100,0],[0,100,0]],solid:true},
    Insert:{block:'existing_block_name',position:[0,0,0],scale:1,rotation_deg:0},
  } });
const fail = () => { throw Error('지원하는 CAD 명령과 입력 범위를 확인해 주세요.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const text = (value,max=200) => typeof value === 'string' && value.trim().length > 0 && value.length<=max && !/[\x00-\x1f]/.test(value);
const numeric = value => Number.isFinite(value) && Math.abs(value)<=1e8;
const point = value => Array.isArray(value) && [2,3].includes(value.length) && value.every(numeric);
const integer = (value,max) => Number.isSafeInteger(value) && value>=0 && value<=max;
const handle = value => typeof value==='string' && /^[A-Fa-f0-9]{1,16}$/.test(value);
const handles = value => Array.isArray(value) && value.length>0 && value.length<=500 && value.every(handle) && new Set(value).size===value.length;
function keys(value,required,optional=[]) { if (!object(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>![...required,...optional].includes(key))) fail(); }
function optional(value,key,check) { if (Object.hasOwn(value,key) && !check(value[key])) fail(); }
function paging(request,max=200) { optional(request,'offset',value=>integer(value,1e7)); optional(request,'limit',value=>integer(value,max) && value>0); }
function clone(request) { if (JSON.stringify(request).length>200000) fail(); return structuredClone(request); }

export function validateDiscoverRequest(request) {
  if (!discoverOps.includes(request?.op)) fail();
  if (request.op==='capabilities') keys(request,['op']);
  if (request.op==='commands') { keys(request,['op'],['search','name','offset','limit']); optional(request,'search',value=>text(value,100)); optional(request,'name',value=>text(value,100)); paging(request,100); }
  if (request.op==='record_schema') { keys(request,['op','type']); if (!text(request.type,100)) fail(); }
  return clone(request);
}
export function validateQueryRequest(request) {
  if (!queryOps.includes(request?.op)) fail();
  const fields = {state:[],query:['type','layer','handles','detail','offset','limit','fields','bounds','near','contains_point','intersections','where'],properties:['handles'],measure:['handles'],layers:['offset','limit'],header:[],history:['limit'],records:['type','handles','detail','offset','limit']};
  keys(request,['op'],fields[request.op]);
  if (['properties','measure'].includes(request.op) && !handles(request.handles)) fail();
  optional(request,'handles',handles); optional(request,'type',value=>text(value,100)); optional(request,'layer',value=>text(value,200));
  optional(request,'detail',value=>['summary','geometry','full'].includes(value)); paging(request);
  optional(request,'fields',value=>Array.isArray(value) && value.length>0 && value.length<=30 && value.every(path=>text(path,150) && !/__(?:proto)__|constructor|prototype/.test(path)));
  optional(request,'bounds',value=>Array.isArray(value) && value.length===4 && value.every(numeric) && value[0]<=value[2] && value[1]<=value[3]);
  optional(request,'near',point); optional(request,'contains_point',value=>point(value) && value.length===2);
  optional(request,'intersections',value=>handles(value) && value.length===2);
  if (Object.hasOwn(request,'where')) {
    if (!Array.isArray(request.where) || !request.where.length || request.where.length>10) fail();
    for (const filter of request.where) {
      keys(filter,['path','op'],['value']);
      if (!text(filter.path,150) || !filter.path.startsWith('/') || /__proto__|constructor|prototype/.test(filter.path) || !['eq','ne','lt','lte','gt','gte','contains','starts_with','ends_with','in','exists','not_exists'].includes(filter.op)) fail();
      if (!['exists','not_exists'].includes(filter.op) && !Object.hasOwn(filter,'value')) fail();
      if (filter.value!==undefined && !(typeof filter.value==='boolean' || filter.value===null || numeric(filter.value) || text(filter.value,500) || (Array.isArray(filter.value) && filter.value.length<=30 && filter.value.every(v=>numeric(v) || text(v,100))))) fail();
    }
  }
  return clone(request);
}
function entity(value) {
  const shape = {Line:['start','end','thickness'],Circle:['center','radius'],Arc:['center','radius','start_angle_deg','end_angle_deg'],LwPolyline:['vertices','closed','constant_width'],Point:['location'],Text:['value','position','height','rotation_deg','style'],MText:['value','position','height','width','rotation_deg','style'],Spline:['control_points','fit_points','degree','knots','weights','closed','periodic','rational','planar','linear'],Insert:['block','position','scale','rotation_deg'],Solid:['corners'],Hatch:['boundary','solid','pattern','pattern_scale','pattern_angle_deg']};
  if (!Object.hasOwn(shape,value?.type)) fail();
  keys(value,['type'],[...shape[value.type],'layer','color']);
  optional(value,'layer',v=>text(v,200) && ![GEO_LAYER,'SITE_GEOREFERENCE'].includes(v.toUpperCase()));
  optional(value,'color',v=>integer(v,256));
  for (const [key,item] of Object.entries(value)) {
    if (['type','layer','color'].includes(key)) continue;
    if (['start','end','center','location','position'].includes(key)) { if (!point(item)) fail(); }
    else if (['vertices','control_points','fit_points','corners','boundary'].includes(key)) { if (!Array.isArray(item) || item.length<2 || item.length>1000 || !item.every(point)) fail(); }
    else if (['closed','periodic','rational','planar','linear','solid'].includes(key)) { if (typeof item!=='boolean') fail(); }
    else if (['value','style','block','pattern'].includes(key)) { if (!text(item, key==='value'?8000:200) || item.startsWith(METADATA_PREFIX)) fail(); }
    else if (['knots','weights'].includes(key)) { if (!Array.isArray(item) || item.length>1011 || !item.every(numeric)) fail(); }
    else if (key==='scale') { if (!(numeric(item) && item!==0) && !(point(item) && item.every(v=>v!==0))) fail(); }
    else if (!numeric(item)) fail();
  }
  for (const key of ['radius','height','width','pattern_scale']) optional(value,key,v=>numeric(v) && v>0);
  optional(value,'degree',v=>integer(v,10) && v>0);
}
export function validateControlRequest(request) {
  if (!controlOps.includes(request?.op)) fail();
  if (['undo','redo'].includes(request.op)) keys(request,['op']);
  if (['run','start'].includes(request.op)) {
    keys(request,['op','cmd']);
    if (!text(request.cmd,4000) || /[;\\"'\x60()[\]{}]/.test(request.cmd)) fail();
    const tokens = request.cmd.trim().split(/\s+/);
    const name = commandName(request.cmd);
    if (isBlockedCommand(name) || tokens[0]!==name || (request.op==='start' && tokens.length!==1)) fail();
    if (tokens.slice(1).some(token=>!/^[@A-Za-z0-9_+.,=-]+$/.test(token) || [GEO_LAYER,'SITE_GEOREFERENCE'].includes(token.toUpperCase()) || (/^@?[+\-.\d]/.test(token) && token.replace(/^@/,'').split(',').some(part=>!numeric(Number(part)))))) fail();
  }
  if (request.op === 'cancel') keys(request,['op']);
  if (request.op === 'input') {
    const fields = {point:['point','space'],entity:['handle','point'],structure:['handle','point'],selection:['handles'],text:['text'],token:['text'],enter:[]};
    if (!Object.hasOwn(fields,request.kind)) fail();
    keys(request,['op','kind'],fields[request.kind]);
    if (['point','entity','structure'].includes(request.kind) && !(point(request.point) && request.point.length===3)) fail();
    optional(request,'space',value=>['wcs','ucs','relative'].includes(value));
    if (['entity','structure'].includes(request.kind) && !handle(request.handle)) fail();
    if (request.kind==='selection' && !(Array.isArray(request.handles) && request.handles.length<=100 && request.handles.every(handle) && new Set(request.handles).size===request.handles.length)) fail();
    if (['text','token'].includes(request.kind) && (!text(request.text,request.kind==='text'?4000:100) || request.text.includes(METADATA_PREFIX) || [GEO_LAYER,'SITE_GEOREFERENCE'].includes(request.text.toUpperCase()))) fail();
    if (request.kind==='token' && !/^[A-Za-z0-9_+.,=-]+$/.test(request.text)) fail();
    if (request.kind==='token' && /^[+\-.\d]/.test(request.text) && request.text.split(',').some(part=>!numeric(Number(part)))) fail();
  }
  if (request.op==='select') { keys(request,['op'],['handles','clear']); if (request.clear!==true && !handles(request.handles)) fail(); if (request.handles?.length>100) fail(); optional(request,'handles',handles); optional(request,'clear',v=>typeof v==='boolean'); }
  if (request.op==='entities_delete') { keys(request,['op','handles']); if (!handles(request.handles)) fail(); }
  if (request.op==='entities_create') { keys(request,['op','entities']); if (!Array.isArray(request.entities) || !request.entities.length || request.entities.length>200) fail(); request.entities.forEach(entity); }
  if (request.op==='entities_transform') {
    const fields={move:['vector'],copy:['vector'],rotate:['center','angle_deg'],scale:['center','factor'],mirror:['axis','copy'],array:['rows','columns','row_spacing','column_spacing']};
    if (!Object.hasOwn(fields,request.action)) fail();
    keys(request,['op','handles','action'],fields[request.action]); if (!handles(request.handles)) fail();
    if (['move','copy'].includes(request.action) && !point(request.vector)) fail();
    if (['rotate','scale'].includes(request.action) && !point(request.center)) fail();
    if (request.action==='rotate' && !numeric(request.angle_deg)) fail();
    if (request.action==='scale' && (!numeric(request.factor) || request.factor===0)) fail();
    if (request.action==='mirror') { if (!Array.isArray(request.axis) || request.axis.length!==2 || !request.axis.every(point) || JSON.stringify(request.axis[0])===JSON.stringify(request.axis[1])) fail(); optional(request,'copy',v=>typeof v==='boolean'); }
    if (request.action==='array' && (!(integer(request.rows,100) && request.rows>0 && integer(request.columns,100) && request.columns>0) || request.rows*request.columns*request.handles.length>2000 || !numeric(request.row_spacing) || !numeric(request.column_spacing))) fail();
  }
  return clone(request);
}
