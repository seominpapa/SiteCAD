import { GEO_LAYER, METADATA_PREFIX } from './geo-reference.js';
import { commandName, isBlockedCommand, approvedCommands } from './command-policy.js';

export const DRAW_COMMANDS = Object.freeze(['LINE','PLINE','RECTANG','CIRCLE','ARC','ELLIPSE','SPLINE','POINT','POLYGON','TEXT','MTEXT','HATCH']);
export const EDIT_COMMANDS = Object.freeze(['MOVE','COPY','ROTATE','SCALE','MIRROR','OFFSET','TRIM','EXTEND','FILLET','CHAMFER','EXPLODE','JOIN','BREAK','PEDIT','ERASE','ARRAY']);
const discoverOps = ['capabilities','commands','record_schema'];
const queryOps = ['state','query','properties','measure','layers','header','history','records','sysvar'];
const controlOps = ['entities_create','entities_delete','entities_transform','select','undo','redo','run','start','input','cancel','set_properties','block_define','block_delete','layout_create','page_setup_set','action','sysvar'];
export const controlSchemas = Object.freeze({ discover: {op:discoverOps}, query:{op:queryOps}, control:{op:controlOps,commands:approvedCommands},
  webLimits:'Native capability lists also include plot/wblock, which are unavailable in this web build. Use cad_save for verified DWG. MVIEW supports ordinary viewport creation, but its INSERT-view branch is unavailable because it switches layouts internally. Automatic annotation sizing applies in Model; paper-space text needs explicit height/style.',
  recordsExample:{op:'records',collection:'layers',name:'벽체',paths:['/name','/color']},
  propertyExample:{op:'set_properties',collection:'entities',handle:'A',updates:[{path:'/common/layer',expected:'0',value:'벽체'}]},
  nativeExamples:[{op:'block_define',name:'기둥',base:[0,0,0],handles:['A']},{op:'layout_create',name:'배치 01'},{op:'action',name:'layout_switch',value:'배치 01'},{op:'page_setup_set',layout:'배치 01',paper:'A4',scale:'1:100'},{op:'sysvar',set:{ltscale:100}}],
  propertyNote:'Read record_schema and records first. set_properties accepts one handle (required for entities) or one table name, with updates:[{path,value,expected}]. expected is required for compare-and-set. Use leaf paths for structural data; identity, references, georeference metadata and drawing units are protected. Read sysvar via cad_query get; set only the supported drawing variables via cad_control. Blocks and sheet operations use existing native operations, not raw objects or header writes.',
  runExample:{op:'run',cmd:'LINE 0,0,0 100,0,0'},
  runNote:'One native command and bounded answers. Discover SiteCAD access first. waiting_input is not completion: read command.accepts/options/input_example, refresh context, then input or cancel. Use start for unfamiliar commands; no newline, quotes or semicolon.',
  modelingNote:'3D modeling uses native run/start/input commands through this same generic connection, not entities_create Solid3D. Discover BOX/CYLINDER/EXTRUDE/REVOLVE/SWEEP/LOFT/UNION/SUBTRACT/INTERSECT and 3D transforms before use. Solid is a filled 2D face, not a volumetric solid; LwPolyline ignores vertex Z. Use 3DPOLY for a polyline with changing Z and 3DFACE/3DMESH for supported faces/meshes. Interactive points use [x,y,z] and explicit wcs. EXTRUDE and other profile/boolean operations may erase sources; query the actual result. measure returns mesh.volume in cubic drawing units and mesh.surface_area in squared drawing units when supported; absent measurements are not zero. Mesh volume and surface area are tessellation approximations and may change after reopen; do not call them exact kernel mass properties. Zero Solid3D bounds after reopen are unavailable, not point geometry; report the limitation instead of validating position or alignment from them. VIEW and VISUALSTYLES are run-only preset forms; inspect state for camera/render results. 3DORBIT is a manual mouse mode, not typed camera control. Solid3D, Mesh and Face3D are not supported flat creation types. SOLIDEDIT currently follows the native shell editing path. Kernel refusal or an empty result is not success.',
  modelingExamples:[{op:'start',cmd:'BOX'},{op:'input',kind:'point',point:[0,0,0],space:'wcs'},{op:'input',kind:'point',point:[6000,4000,0],space:'wcs'},{op:'input',kind:'token',text:'3000'},{op:'run',cmd:'VIEW SWISO'},{op:'run',cmd:'VISUALSTYLES GOURAUDSHADEDWITHEDGES'}],
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
const reserved = value => typeof value==='string' && ([GEO_LAYER,'SITE_GEOREFERENCE'].includes(value.toUpperCase()) || value.toUpperCase().includes(METADATA_PREFIX.toUpperCase()));
const name = value => text(value,200) && value===value.trim() && !/[\\/:*?"<>|;`]/.test(value) && !['.','..'].includes(value) && !reserved(value);
const collection = value => typeof value==='string' && /^[a-z_]{1,60}$/.test(value);
const pointer = value => text(value,200) && value.startsWith('/') && !/~(?![01])/.test(value) && value.slice(1).split('/').every(part=>part.length && !['__proto__','constructor','prototype'].includes(part.replace(/~1/g,'/').replace(/~0/g,'~').toLowerCase()));
const writableCollections = ['entities','layers','line_types','text_styles','dim_styles'];
const sysvars = ['clayer','ctextstyle','ltscale','celtscale','textsize','filletrad','pdmode','pdsize','mirrtext','osmode'];
const readableSysvars = [...sysvars,'insunits','extmin','extmax'];
const token = value => /^[\p{L}\p{M}\p{N}_+.,=@ -]+$/u.test(value) && !reserved(value);
const handle = value => typeof value==='string' && /^[A-Fa-f0-9]{1,16}$/.test(value);
const handles = value => Array.isArray(value) && value.length>0 && value.length<=500 && value.every(handle) && new Set(value).size===value.length;
function keys(value,required,optional=[]) { if (!object(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>![...required,...optional].includes(key))) fail(); }
function optional(value,key,check) { if (Object.hasOwn(value,key) && !check(value[key])) fail(); }
function paging(request,max=200) { optional(request,'offset',value=>integer(value,1e7)); optional(request,'limit',value=>integer(value,max) && value>0); }
function safeJson(value,depth=0,geometry=false) {
  if (depth>8) return false;
  if (value===null || typeof value==='boolean' || numeric(value)) return true;
  if (typeof value==='string') return !geometry && value.length<=8000 && !/[\x00-\x1f]/.test(value) && !reserved(value);
  if (Array.isArray(value)) return value.length<=1000 && value.every(item=>safeJson(item,depth+1,geometry));
  return object(value) && Object.keys(value).length<=40 && Object.entries(value).every(([key,item])=>pointer('/'+key) && !/(?:^|_)(?:handle|owner|reactor|xdata|extension_dictionary)(?:$|_)/i.test(key) && safeJson(item,depth+1,geometry));
}
function validateProperties(request) {
  keys(request,['op','collection','updates'],['handle','name']);
  if (!writableCollections.includes(request.collection) || Number(Object.hasOwn(request,'handle'))+Number(Object.hasOwn(request,'name'))!==1) fail();
  optional(request,'handle',handle); optional(request,'name',name);
  if (request.collection==='entities' && !handle(request.handle)) fail();
  if (!Array.isArray(request.updates) || !request.updates.length || request.updates.length>100) fail();
  for (const update of request.updates) {
    keys(update,['path','value','expected']);
    if (!pointer(update.path) || !safeJson(update.expected) || !safeJson(update.value,0,typeof update.value==='object')) fail();
    const parts=update.path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
    if (parts.some(part=>/(?:^|_)(?:handles?|owner|reactors?|xdata|extension_dictionary|block_name|entity_handles)(?:$|_)/i.test(part)) || (parts.length===1 && ['common','attributes','entities'].includes(parts[0])) || (request.collection!=='entities' && parts[0]==='name')) fail();
    if (parts.at(-1)==='layer' && !name(update.value)) fail();
    if (/(?:font|file|path)/i.test(parts.at(-1)) && typeof update.value==='string' && !/^[\p{L}\p{N}_ .-]{1,200}$/u.test(update.value)) fail();
  }
}
function validateSysvarSet(request) {
  keys(request,['op','set']);
  if (!object(request.set) || !Object.keys(request.set).length || Object.keys(request.set).length>sysvars.length) fail();
  const names=Object.keys(request.set).map(key=>key.toLowerCase());
  if (new Set(names).size!==names.length) fail();
  for (const [key,value] of Object.entries(request.set)) {
    const variable=key.toLowerCase();
    if (!sysvars.includes(variable)) fail();
    if (['clayer','ctextstyle'].includes(variable)) { if (!name(value)) fail(); }
    else if (['ltscale','celtscale','textsize'].includes(variable)) { if (!numeric(value) || value<=0) fail(); }
    else if (variable==='filletrad') { if (!numeric(value) || value<0) fail(); }
    else if (['pdmode','osmode'].includes(variable)) { if (!integer(value,32767)) fail(); }
    else if (variable==='mirrtext') { if (![0,1].includes(value)) fail(); }
    else if (!numeric(value)) fail();
  }
}
function clone(request) { if (JSON.stringify(request).length>200000) fail(); return structuredClone(request); }

export function validateDiscoverRequest(request) {
  if (!discoverOps.includes(request?.op)) fail();
  if (request.op==='capabilities') keys(request,['op']);
  if (request.op==='commands') { keys(request,['op'],['search','name','offset','limit']); optional(request,'search',value=>text(value,100)); optional(request,'name',value=>text(value,100)); paging(request,100); }
  if (request.op==='record_schema') {
    keys(request,['op'],['collection','type','search','offset','limit']);
    if (!Object.hasOwn(request,'collection') && !Object.hasOwn(request,'type')) fail();
    optional(request,'collection',collection); optional(request,'type',value=>text(value,100)); optional(request,'search',value=>text(value,100)); paging(request);
  }
  return clone(request);
}
export function validateQueryRequest(request) {
  if (!queryOps.includes(request?.op)) fail();
  const fields = {state:[],query:['type','layer','handles','detail','offset','limit','fields','bounds','near','contains_point','intersections','where'],properties:['handles'],measure:['handles'],layers:['offset','limit'],header:[],history:['limit'],records:['collection','name','handle','handles','type','detail','paths','where','offset','limit'],sysvar:['get']};
  keys(request,['op'],fields[request.op]);
  if (request.op==='sysvar' && (!Array.isArray(request.get) || !request.get.length || request.get.length>readableSysvars.length || request.get.some(value=>typeof value!=='string' || !readableSysvars.includes(value.toLowerCase())) || new Set(request.get.map(value=>value.toLowerCase())).size!==request.get.length)) fail();
  optional(request,'collection',collection); optional(request,'name',value=>text(value,200)); optional(request,'handle',handle);
  optional(request,'paths',value=>Array.isArray(value) && value.length>0 && value.length<=30 && value.every(pointer));
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
      if (!pointer(filter.path) || !['eq','ne','lt','lte','gt','gte','contains','starts_with','ends_with','in','exists','not_exists'].includes(filter.op)) fail();
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
  if (request.op==='set_properties') validateProperties(request);
  if (request.op==='sysvar') validateSysvarSet(request);
  if (request.op==='block_define') {
    keys(request,['op','name','base','handles'],['insert_at','replace']);
    if (!name(request.name) || !point(request.base) || !handles(request.handles)) fail();
    optional(request,'insert_at',point); optional(request,'replace',value=>typeof value==='boolean');
  }
  if (request.op==='block_delete') { keys(request,['op','name'],['force']); if (!name(request.name)) fail(); optional(request,'force',value=>typeof value==='boolean'); }
  if (request.op==='layout_create') { keys(request,['op','name']); if (!name(request.name)) fail(); }
  if (request.op==='action') { keys(request,['op','name','value']); if (request.name!=='layout_switch' || !name(request.value)) fail(); }
  if (request.op==='page_setup_set') {
    keys(request,['op','layout'],['paper','orientation','fit','scale','center','window','plot_style']);
    if (!name(request.layout) || (Object.hasOwn(request,'orientation') && !Object.hasOwn(request,'paper'))) fail();
    optional(request,'paper',value=>text(value,200) && /^[\p{L}\p{N}_ .()×-]+$/u.test(value));
    optional(request,'orientation',value=>['landscape','portrait'].includes(value));
    for (const key of ['fit','center']) optional(request,key,value=>typeof value==='boolean');
    optional(request,'scale',value=>typeof value==='string' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value) && value.split(':').every(part=>numeric(Number(part)) && Number(part)>0));
    optional(request,'window',value=>Array.isArray(value) && value.length===4 && value.every(numeric) && value[0]<value[2] && value[1]<value[3]);
    optional(request,'plot_style',value=>value==='' || (name(value) && /\.(?:ctb|stb)$/i.test(value)));
  }
  if (['undo','redo'].includes(request.op)) keys(request,['op']);
  if (['run','start'].includes(request.op)) {
    keys(request,['op','cmd']);
    if (!text(request.cmd,4000) || /[;\\"'\x60()[\]{}]/.test(request.cmd)) fail();
    const tokens = request.cmd.trim().split(/\s+/);
    const name = commandName(request.cmd);
    if (isBlockedCommand(name,request.cmd) || tokens[0]!==name || (request.op==='start' && tokens.length!==1)) fail();
    if (tokens.slice(1).some(token=>!/^[@\p{L}\p{M}\p{N}_+.,=-]+$/u.test(token) || reserved(token) || (/^@?[+\-.\d]/.test(token) && !/[\p{L}\p{M}]/u.test(token) && token.replace(/^@/,'').split(',').some(part=>!numeric(Number(part)))))) fail();
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
    if (['text','token'].includes(request.kind) && (!text(request.text,request.kind==='text'?4000:200) || reserved(request.text))) fail();
    if (request.kind==='token' && !token(request.text)) fail();
    if (request.kind==='token' && /^[+\-.\d]/.test(request.text) && !/[\p{L}\p{M}]/u.test(request.text) && request.text.split(',').some(part=>!numeric(Number(part)))) fail();
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
