import { validateControlRequest, validateQueryRequest, validateDiscoverRequest, controlSchemas } from './control-schema.js';
import { commandName, commandAccess, validateAliases } from './command-policy.js';
import { GEO_LAYER } from './geo-reference.js';
import { mmPerUnit } from './units.js';
import { prepareText, prepareDimension } from './annotations.js';

const selection = value => JSON.stringify([...(value || [])].sort());
const cancelled = signal => { if (signal?.aborted) throw Error('작업을 취소했습니다.'); };
const same = (a, b) => a.document_id === b.document_id && a.revision === b.revision &&
  a.geometry_revision === b.geometry_revision && a.layout === b.layout && selection(a.selection) === selection(b.selection);
const pendingCommands = new WeakMap();
const dimensionCommands = new Set(['DIMLINEAR','DIMALIGNED','DIMRADIUS','DIMDIAMETER','DIMANGULAR','DIMARC','DIMORDINATE','DIMJOGGED','DIMJOG','DIMBASELINE','DIMCONTINUE','QDIM']);
const sameCommand = (a, b) => same(a, b) && JSON.stringify(a.command) === JSON.stringify(b.command) &&
  ['session_id','selection_revision','hand_seed','modal','text_editor','mtext_editor'].every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
const unchanged = (a, b) => sameCommand(a, b) && a.event_cursor === b.event_cursor;
export const hasPendingCompatibility = cad => Boolean(pendingCommands.get(cad)?.compatibility);
export const isOwnedCommand = (cad, state) => Boolean(pendingCommands.get(cad) && unchanged(pendingCommands.get(cad).state, state));

async function nativeCommand(cad, request, state) {
  const name = commandName(request.cmd);
  const manifest = await cad.request({ op:'commands', name });
  const access = commandAccess(manifest.command);
  if (manifest.command?.name !== name || !access.allowed) throw Error(access.reason || '현재 편집기에서 실행할 수 없는 명령입니다.');
  if (state.plugins?.length) throw Error('플러그인이 로드된 편집기의 범용 명령은 실행할 수 없습니다.');
  const storage = cad.iframe?.contentWindow?.localStorage;
  validateAliases(storage?.getItem('opencadstudio.aliases') ?? '', name);
  return { name, ...access };
}

async function guarded(cad, expected, signal) {
  cancelled(signal);
  const state = await cad.snapshot();
  if (!expected || state.document_id !== expected.documentId || state.revision !== expected.revision ||
    selection(state.selection) !== selection(expected.selection) ||
    (expected.geometryRevision != null && state.geometry_revision !== expected.geometryRevision) ||
    (expected.layout != null && state.layout !== expected.layout)) throw Error('도면이나 선택이 변경되었습니다. 현재 상태를 다시 조회해 주세요.');
  const header = await cad.request({ op: 'header' });
  if (header.insertion_units !== expected.units) throw Error('도면 단위가 변경되었습니다. 현재 상태를 다시 조회해 주세요.');
  if (!same(state, await cad.snapshot())) throw Error('도면 조회 중 상태가 변경되었습니다.');
  cancelled(signal);
  return state;
}

async function stable(cad, before, units, signal) {
  cancelled(signal);
  const header = await cad.request({ op: 'header' });
  const after = await cad.snapshot();
  if (!unchanged(before, after) || header.insertion_units !== units) throw Error('조회 중 도면이나 선택이 변경되었습니다. 다시 조회해 주세요.');
  return after;
}

export async function discoverDrawing(cad, args) {
  const checked = validateDiscoverRequest(args.request);
  const request = ['commands', 'record_schema'].includes(checked.op) ? { limit: 100, ...checked } : checked;
  const result = await cad.request(request);
  return { result, sitecad: { ...controlSchemas, ...(result.command ? { commandAccess: commandAccess(result.command) } : {}), ...(result.commands ? { commandAccess: result.commands.map(name => ({name,...commandAccess({name})})) } : {}) }, coordinateUnits: 'drawing units', angles: 'degrees' };
}

async function objectProperties(cad, requested, state, units, signal) {
  const handles = [...new Set(requested.map(handle => BigInt(`0x${handle}`).toString(16).toUpperCase()))];
  let entities = [];
  // Native properties reads the selection panel and ignores requested handles.
  for (let offset = 0; offset < handles.length; offset += 200) {
    if (offset) await stable(cad, state, units, signal);
    cancelled(signal);
    const batch = handles.slice(offset, offset + 200);
    const result = await cad.request({ op: 'query', handles: batch, detail: 'full', limit: batch.length });
    if (!Array.isArray(result.entities) || result.entities.length !== batch.length ||
      new Set(result.entities.map(entity => entity?.handle)).size !== batch.length ||
      result.entities.some(entity => !batch.includes(entity?.handle))) throw Error('요청한 객체의 속성을 모두 확인하지 못했습니다. 객체를 다시 조회해 주세요.');
    entities = entities.concat(result.entities);
  }
  return { ok: true, entities, count: entities.length, returned: entities.length };
}

export async function queryDrawing(cad, { request: input, expectedContext }, { signal } = {}) {
  const scale = mmPerUnit(expectedContext?.units);
  const checked = validateQueryRequest(input);
  const request = ['query', 'records', 'layers', 'history'].includes(checked.op) ? { limit: 200, ...checked } : checked;
  const state = await guarded(cad, expectedContext, signal);
  const result = checked.op === 'properties'
    ? await objectProperties(cad, checked.handles, state, expectedContext.units, signal)
    : await cad.request(request);
  await stable(cad, state, expectedContext.units, signal);
  return { result, units: expectedContext.units, mmPerDrawingUnit: scale };
}

async function protectTargets(cad, request, access) {
  if (['run','start','input'].includes(request.op) || (request.op === 'entities_create' && request.entities.some(entity => !entity.layer))) {
    const header = await cad.request({ op:'header' });
    if ([GEO_LAYER,'SITE_GEOREFERENCE'].includes(header.current_layer?.toUpperCase())) throw Error('공간 기준 레이어를 현재 작도 레이어로 사용할 수 없습니다.');
  }
  const handles = ['entities_delete','entities_transform'].includes(request.op) ? request.handles
    : request.op === 'input' ? (request.handles || (request.handle ? [request.handle] : [])) : [];
  if (handles.length) {
    const result = await cad.request({ op:'query', handles, detail:'full', limit:handles.length });
    if (result.entities?.length !== handles.length) throw Error('수정 대상 객체를 모두 확인하지 못했습니다.');
    if (result.entities.some(entity => [GEO_LAYER,'SITE_GEOREFERENCE'].includes(entity.layer?.toUpperCase()))) throw Error('도면의 공간 기준 객체는 수정하거나 삭제할 수 없습니다.');
  }
  if (access && !access.createsOnly && !access.readOnly) {
    const result = await cad.request({ op:'query', layer:GEO_LAYER, detail:'summary', limit:1 });
    if (result.entities?.length) throw Error('공간 기준이 있는 도면의 수정은 객체 핸들을 지정하는 도구를 사용해 주세요.');
  }
}

async function execute(cad, request, state) {
  const control = cad.iframe?.contentWindow?.ocsControl;
  if (!control) return cad.mutate(request, state);
  return control.request({ protocol:1, request_id:crypto.randomUUID(), document_id:state.document_id,
    revision:state.revision, geometry_revision:state.geometry_revision, selection:state.selection, ...request }, {timeoutMs:60_000});
}

async function dimensionMode(cad) {
  const result = await cad.request({op:'records',collection:'header'});
  const mode = result.records?.[0]?.properties?.dimension_associativity;
  if (!result.ok || ![0,1,2].includes(mode)) throw Error('치수 연관 설정을 확인하지 못했습니다.');
  return mode;
}

async function changeDimensionMode(cad, before, compatibility, expected, value) {
  if (await dimensionMode(cad) !== expected) throw Error('치수 연관 설정이 변경되었습니다.');
  validateAliases(cad.iframe?.contentWindow?.localStorage?.getItem('opencadstudio.aliases') ?? '', 'SETVAR');
  if (before.plugins?.length) throw Error('플러그인이 로드된 편집기의 치수 설정은 변경할 수 없습니다.');
  await stable(cad, before, compatibility.units);
  // SETVAR does not add undo entries; record updates would hide the drawing edit behind two header undos.
  const reply = await execute(cad, {op:'run',cmd:`SETVAR DIMASSOC ${value}`}, before);
  const after = await cad.snapshot();
  if (!reply?.ok || !reply.state || !sameCommand(reply.state, after) ||
    after.document_id !== before.document_id || after.layout !== before.layout ||
    selection(after.selection) !== selection(before.selection) || JSON.stringify(after.command) !== JSON.stringify(before.command)) {
    throw Error('치수 연관 설정 변경 결과를 확인하지 못했습니다.');
  }
  if (value === 1) pendingCommands.set(cad, {...pendingCommands.get(cad),state:after,compatibility});
  if (await dimensionMode(cad) !== value) throw Error('치수 연관 설정 변경 결과가 다릅니다.');
  await stable(cad, after, compatibility.units);
  return after;
}

async function restoreDimensionMode(cad) {
  const pending = pendingCommands.get(cad);
  if (!pending?.compatibility) return;
  const current = await cad.snapshot();
  if (!isOwnedCommand(cad, current) || current.command || current.modal) throw Error('도면 상태가 변경되어 치수 연관 설정을 복원하지 않았습니다. 현재 설정을 확인해 주세요.');
  try {
    const after = await changeDimensionMode(cad, current, pending.compatibility, 1, 2);
    pendingCommands.set(cad, {...pending,state:after,compatibility:null});
  } catch (error) {
    throw Error('치수 연관 설정을 복원하지 못했습니다. 도면을 확인해 주세요.', {cause:error});
  }
}

export async function cancelOwnedCommand(cad) {
  const current = await cad.snapshot();
  if (!isOwnedCommand(cad, current)) {
    const compatibility = pendingCommands.get(cad)?.compatibility;
    pendingCommands.delete(cad);
    if (compatibility) throw Error('도면 상태가 변경되어 치수 연관 설정을 복원하지 않았습니다. 현재 설정을 확인해 주세요.');
    return {cancelled:false};
  }
  if (!current.command && !current.modal) { await restoreDimensionMode(cad); pendingCommands.delete(cad); return {cancelled:false}; }
  const reply = await execute(cad, {op:current.modal ? 'action' : 'cancel', ...(current.modal ? {name:'close_modal'} : {})}, current);
  const after = await cad.snapshot();
  if (!reply?.ok || (reply.state && !sameCommand(reply.state,after)) || after.document_id !== current.document_id || after.layout !== current.layout || after.command || after.modal) throw Error('진행 중 명령을 취소하지 못했습니다. 편집기 상태를 확인해 주세요.');
  pendingCommands.set(cad, {...pendingCommands.get(cad),state:after});
  await restoreDimensionMode(cad);
  pendingCommands.delete(cad);
  return {cancelled:true};
}

function checkInput(request, command) {
  if (!command?.accepts?.includes(request.kind)) throw Error('진행 중 명령의 accepts와 input_example에 맞는 입력을 보내 주세요.');
  if (request.kind === 'token') {
    const options = command.options || [];
    // Numeric prompt answers may be tokens; named options must match the advertised keyword.
    if (options.length && !Number.isFinite(Number(request.text)) && !options.some(option => (typeof option === 'string' ? option : option.keyword)?.toUpperCase() === request.text.toUpperCase())) {
      throw Error('진행 중 명령이 제공한 옵션 토큰을 사용해 주세요.');
    }
  }
}

function updateHandles(cad, reply, after, previous) {
  const created = Array.isArray(reply.result?.handles) ? reply.result.handles : Array.isArray(reply.result?.created) ? reply.result.created : [];
  const handles = [...new Set([...(previous || []), ...created, ...(reply.changes || []).filter(change => change.kind === 'Added').map(change => change.handle)])];
  if (handles.length) { cad.lastHandles = handles; cad.lastDocument = after.document_id; }
  return handles;
}

export async function controlDrawing(cad, { request:input, expectedContext }, {signal} = {}) {
  let request = validateControlRequest(input);
  const scale = mmPerUnit(expectedContext?.units);
  let state = await guarded(cad, expectedContext, signal);
  const continuation = ['input','cancel'].includes(request.op);
  const pending = pendingCommands.get(cad);
  if (!continuation && pending?.compatibility) throw Error('이전 치수 연관 설정 복원이 끝나지 않았습니다. 작업을 정리한 뒤 다시 조회해 주세요.');
  if (continuation && !isOwnedCommand(cad, state)) throw Error('현재 명령은 SiteCAD가 시작한 상태와 다릅니다. 사용자의 명령은 이어서 실행하거나 취소하지 않습니다.');
  if (!continuation && (state.modal || state.command || state.text_editor || state.mtext_editor)) throw Error('편집기의 진행 중 명령이나 대화상자를 먼저 닫아 주세요.');
  if (continuation && state.modal) throw Error('진행 중 대화상자는 입력 명령으로 처리할 수 없습니다.');
  if (request.op === 'input') checkInput(request, state.command);
  const access = ['run','start'].includes(request.op) ? await nativeCommand(cad, request, state) : continuation ? pending.access : null;
  if (request.op !== 'cancel') await protectTargets(cad, request, access);
  await stable(cad, state, expectedContext.units, signal);
  if (request.op === 'input' && request.kind === 'selection') {
    // Native selection input consumes the current selection and ignores handles.
    const selected = await execute(cad, request.handles.length ? {op:'select',handles:request.handles} : {op:'select',clear:true}, state);
    const afterSelection = await cad.snapshot();
    if (!selected?.ok || !selected.state || !sameCommand(selected.state, afterSelection) ||
      afterSelection.document_id !== state.document_id || afterSelection.layout !== state.layout ||
      JSON.stringify(state.command) !== JSON.stringify(afterSelection.command)) throw Error('명령 입력 대상을 선택하는 중 도면이 변경되었습니다.');
    pendingCommands.set(cad, {...pending,state:afterSelection});
    state = await guarded(cad, {...expectedContext,revision:afterSelection.revision,geometryRevision:afterSelection.geometry_revision,selection:afterSelection.selection}, signal);
    if (!isOwnedCommand(cad, state)) throw Error('선택 후 명령 상태가 변경되었습니다.');
  }
  let compatibility = continuation ? pending.compatibility : null;
  let annotation = null;
  const annotationIO = {
    layout:state.layout,
    check: () => stable(cad, state, expectedContext.units, signal),
    write: async operation => {
      if (operation.op === 'run') {
        if (state.plugins?.length) throw Error('플러그인이 로드된 편집기의 주석 스타일은 변경할 수 없습니다.');
        validateAliases(cad.iframe?.contentWindow?.localStorage?.getItem('opencadstudio.aliases') ?? '', commandName(operation.cmd));
      }
      await stable(cad, state, expectedContext.units, signal);
      const reply = await execute(cad, operation, state);
      const after = await cad.snapshot();
      // Font registration invalidates the next rendered frame without changing document contents.
      const fontRender = operation.op === 'font_register' && after.revision === state.revision &&
        reply?.result?.file_name === 'AppleGothic.ttf' && reply.result.family === 'AppleGothic' && reply.result.faces === 1;
      const reported = fontRender ? {...reply.state,geometry_revision:after.geometry_revision} : reply?.state;
      if (!reply?.ok || !reply.state || !sameCommand(reported, after) || after.document_id !== state.document_id ||
        after.layout !== state.layout || selection(after.selection) !== selection(state.selection) ||
        after.command || after.modal || after.text_editor || after.mtext_editor) throw Error('주석 설정 중 도면이나 선택이 변경되었습니다. 현재 도면을 확인해 주세요.');
      state = after;
      await stable(cad, state, expectedContext.units, signal);
      return reply;
    }
  };
  try {
    ({request,annotation} = await prepareText(cad, request, expectedContext.units, annotationIO));
    if (access && dimensionCommands.has(access.name) && !continuation) {
      const mode = await dimensionMode(cad);
      await stable(cad, state, expectedContext.units, signal);
      if (mode === 2) {
        // shortcut: this engine exports broken dimension references; remove after an AutoCAD-verified engine fix.
        compatibility = {units:expectedContext.units};
        state = await changeDimensionMode(cad, state, compatibility, 2, 1);
        pendingCommands.set(cad, {state,access,handles:[],compatibility});
      }
    }
    cancelled(signal);
    const nativeRequest = request.op === 'input' && request.kind === 'selection' ? {op:'input',kind:'selection'} : request;
    const reply = await execute(cad, nativeRequest, state);
    const after = await cad.snapshot();
    const header = await cad.request({op:'header'});
    if (after.document_id !== state.document_id || after.layout !== state.layout || header.insertion_units !== expectedContext.units ||
      (reply?.state && !sameCommand(reply.state, after))) throw Error('실행 결과 확인 중 도면이나 명령 상태가 변경되었습니다. 현재 도면을 확인해 주세요.');
    const handles = updateHandles(cad, reply || {}, after, continuation ? pending.handles : []);
    if (after.command || after.modal || compatibility) pendingCommands.set(cad, {state:after,access,handles,compatibility});
    else pendingCommands.delete(cad);
    let finalState = after;
    if (!after.command && !after.modal && compatibility) {
      await restoreDimensionMode(cad);
      finalState = pendingCommands.get(cad).state;
      pendingCommands.delete(cad);
    }
    cancelled(signal);
    if (!reply?.ok || !['completed','waiting_input','cancelled'].includes(reply.status ?? 'completed')) throw Error(typeof reply?.error === 'string' ? reply.error : 'CAD 명령 실행 결과를 확인하지 못했습니다. 도면을 확인해 주세요.');
    if (after.modal) throw Error('이 명령은 대화상자를 열었습니다. 명령줄 방식이나 형식이 정해진 도구를 사용해 주세요.');
    if (reply.status === 'waiting_input' && !after.command) throw Error('후속 입력을 기다리는 명령 상태를 확인하지 못했습니다.');
    if (after.command && reply.status !== 'waiting_input') throw Error('명령이 끝나지 않았습니다. 현재 입력 상태를 다시 조회해 주세요.');
    if (!after.command && !after.modal && dimensionCommands.has(access?.name) && reply.status !== 'cancelled') {
      state = finalState;
      await stable(cad, state, expectedContext.units, signal);
      annotation = await prepareDimension(cad, handles, expectedContext.units, annotationIO);
    }
    if (!handles.length && ['entities_delete','undo','redo'].includes(request.op)) cad.lastHandles = [];
    const status = reply.status ?? 'completed';
    return {status, command:after.command ?? null, result:reply.result ?? {}, changes:reply.changes ?? [], ...(annotation ? {annotation} : {}),
      details:[...(compatibility ? ['AutoCAD 호환성을 위해 새 치수는 비연관 치수로 생성합니다. 기존 치수는 유지합니다.'] : []), status === 'waiting_input' ? 'CAD 명령이 후속 입력을 기다리고 있습니다.' : status === 'cancelled' ? 'CAD 명령을 취소했습니다. 이미 생성된 객체는 남아 있을 수 있습니다.' : 'CAD 명령 실행 완료'],
      units:expectedContext.units, mmPerDrawingUnit:scale};
  } catch (error) {
    const own = pendingCommands.get(cad);
    if (!error.message.includes('복원') && own?.compatibility && isOwnedCommand(cad, await cad.snapshot()) && !own.state.command && !own.state.modal) {
      await restoreDimensionMode(cad);
      pendingCommands.delete(cad);
    }
    throw error;
  }
}
