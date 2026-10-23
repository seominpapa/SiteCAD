import { discoverDrawing, queryDrawing, controlDrawing, isOwnedCommand, cancelOwnedCommand, hasPendingCompatibility } from './cad-control.js';
import { insertTerrain } from './terrain-cad.js';
import { collectQuantities } from './quantities.js';
import { mmPerUnit } from './units.js';
import { parcelContext, insertParcels, readGeoreferences } from './parcel-cad.js';
export { mmPerUnit } from './units.js';

const MAX_COORDINATE_MM = 100_000_000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function number(value, positive = false) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_MM || (positive && value <= 0)) {
    throw new Error('도면 좌표와 치수는 유효한 범위의 숫자여야 합니다.');
  }
  return value;
}

export function entityDefinition(operation, units) {
  const scale = mmPerUnit(units);
  const point = (x, y) => [number(x) / scale, number(y) / scale, 0];
  const layer = 'AI_DRAFT';
  if (operation.type === 'rectangle') {
    const { x_mm: x, y_mm: y, width_mm: w, height_mm: h } = operation;
    number(w, true); number(h, true);
    return { type: 'LwPolyline', vertices: [point(x, y), point(x + w, y),
      point(x + w, y + h), point(x, y + h)], closed: true, layer };
  }
  if (operation.type === 'circle') return { type: 'Circle', center: point(operation.x_mm, operation.y_mm),
    radius: number(operation.radius_mm, true) / scale, layer };
  if (operation.type === 'line') {
    const start = point(operation.x1_mm, operation.y1_mm);
    const end = point(operation.x2_mm, operation.y2_mm);
    if (start[0] === end[0] && start[1] === end[1]) throw new Error('선의 시작점과 끝점이 같습니다.');
    return { type: 'Line', start, end, layer };
  }
  throw new Error('허용되지 않은 작도 명령입니다.');
}

function errorMessage(reply) {
  return typeof reply.error === 'string' ? reply.error : reply.error?.message || reply.code || '편집기 작업에 실패했습니다.';
}

function fromBase64(base64) {
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export function toBase64(bytes) {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(raw);
}

function sameSelection(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export class CadEditor {
  constructor(iframe) {
    this.iframe = iframe;
    this.lastHandles = [];
    this.lastDocument = null;
    this.sourceVersion = null;
    this.units = 4;
  }

  async request(request) {
    const control = this.iframe.contentWindow?.ocsControl;
    if (!control) throw new Error('편집기를 아직 불러오는 중입니다.');
    const reply = await control.request(request, { timeoutMs: 60_000 });
    if (!reply?.ok || ['failed', 'waiting_input', 'accepted', 'running'].includes(reply.status)) {
      throw new Error(errorMessage(reply || {}));
    }
    return reply;
  }

  async snapshot() { return { ...await this.request({ op: 'state' }), units: this.units }; }

  async mutate(operation, expected, { signal } = {}) {
    if (hasPendingCompatibility(this)) throw Error('치수 연관 설정 복원이 완료되지 않았습니다. 진행 중 작업을 정리한 뒤 다시 시도해 주세요.');
    const state = await this.snapshot();
    if (expected && (state.document_id !== expected.document_id || state.revision !== expected.revision ||
      (expected.geometry_revision != null && state.geometry_revision !== expected.geometry_revision) ||
      (expected.layout != null && state.layout !== expected.layout) ||
      (expected.selection != null && !sameSelection(state.selection || [], expected.selection)))) {
      throw new Error('도면이 변경되었습니다. 현재 도면에서 요청을 다시 보내 주세요.');
    }
    if (state.modal || state.command || state.text_editor || state.mtext_editor) throw new Error('편집기의 진행 중 명령이나 대화상자를 먼저 닫아 주세요.');
    if (signal?.aborted) throw new Error('작업을 취소했습니다.');
    return this.request({ protocol: 1, request_id: crypto.randomUUID(),
      document_id: state.document_id, revision: state.revision,
      ...(!expected && ['new','open'].includes(operation.op) ? {} : {geometry_revision:state.geometry_revision}),
      selection:state.selection, ...operation });
  }

  async ready() {
    const deadline = Date.now() + 120_000;
    while (!this.iframe.contentWindow?.ocsControl) {
      if (Date.now() > deadline) throw new Error('편집기 로딩 시간이 초과되었습니다. 페이지를 새로고침해 주세요.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let timer;
    try {
      await Promise.race([this.iframe.contentWindow.ocsControl.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CAD 제어 연결 시간 초과')), 120_000); })]);
    } finally { clearTimeout(timer); }
    let state = await this.snapshot();
    for (let attempt = 0; state.modal && attempt < 3; attempt++) {
      await this.request({ protocol: 1, request_id: crypto.randomUUID(), op: 'action',
        name: 'close_modal', document_id: state.document_id, revision: state.revision });
      state = await this.snapshot();
    }
    const capabilities = await this.request({ op: 'capabilities' });
    for (const operation of ['entities_create', 'entities_transform', 'sysvar']) {
      if (!capabilities.operations?.[operation]) throw new Error(`편집기가 필요한 기능을 지원하지 않습니다: ${operation}`);
    }
    if (state.documents?.find(d => d.id === state.document_id)?.start) {
      try { return await this.newDrawing(); }
      catch (error) {
        const current = await this.snapshot();
        if (current.modal !== 'AutosaveRestore') throw error;
        // Startup restoration may appear after the engine's ready promise resolves.
        await this.request({ protocol: 1, request_id: crypto.randomUUID(), op: 'action',
          name: 'close_modal', document_id: current.document_id, revision: current.revision });
        return this.newDrawing();
      }
    }
    return state;
  }

  async newDrawing() {
    await this.mutate({ op: 'new' });
    let state = await this.snapshot();
    if (state.documents?.find(d => d.id === state.document_id)?.start) throw new Error('새 도면을 만들지 못했습니다.');
    for (let attempt=0; ; attempt++) {
      try { await this.mutate({op:'sysvar',set:{insunits:4}},state); break; }
      catch (error) {
        const current=await this.snapshot();
        // A new blank tab's first render can advance geometry without an edit.
        if (attempt>=2 || current.document_id!==state.document_id || current.revision!==state.revision ||
          current.geometry_revision===state.geometry_revision || current.command || current.modal || current.text_editor || current.mtext_editor ||
          !sameSelection(current.selection||[],state.selection||[])) throw error;
        state=current;
      }
    }
    const header = await this.request({ op: 'header' });
    if (header.insertion_units !== 4) throw new Error('새 도면의 mm 단위를 설정하지 못했습니다.');
    this.units = 4; this.sourceVersion = 'AC1032'; this.lastHandles = [];
    this.lastDocument = (await this.snapshot()).document_id;
    this.createdDocumentId = this.lastDocument;
    return this.snapshot();
  }

  async openFile(file) {
    if (!/\.(dwg|dxf)$/i.test(file.name) || !file.size || file.size > MAX_FILE_BYTES) {
      throw new Error('30MB 이하의 DWG 또는 DXF 파일을 선택해 주세요.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.dwg$/i.test(file.name) && !/^AC10\d\d$/.test(new TextDecoder().decode(bytes.slice(0, 6)))) {
      throw new Error('DWG 파일 헤더가 올바르지 않습니다.');
    }
    await this.mutate({ op: 'open', name: file.name, data_base64: toBase64(bytes) });
    this.createdDocumentId = null;
    const audit = await this.request({ op: 'audit' });
    const header = await this.request({ op: 'header' });
    this.units = header.insertion_units;
    this.sourceVersion = audit.source?.format === 'dwg' ? audit.source.version : 'AC1032';
    this.lastHandles = []; this.lastDocument = (await this.snapshot()).document_id;
    await this.fit();
    return this.snapshot();
  }

  async fit() { return this.mutate({ op: 'action', name: 'zoom_extents' }); }
  async discover(args) { return discoverDrawing(this, args); }
  async query(args, options) { return queryDrawing(this, args, options); }
  async control(args, options) { return controlDrawing(this, args, options); }
  async cancelPendingCommand() { return cancelOwnedCommand(this); }
  async parcelContext(expected, options) { return parcelContext(this, expected, options); }
  async insertParcels(plan, expected, options) { return insertParcels(this, plan, expected, options); }
  async insertTerrain(plan, expected, options) { return insertTerrain(this, plan, expected, options); }
  async undo() {
    const result = await this.mutate({ op: 'undo' });
    this.lastHandles = [];
    return result;
  }

  async context() {
    const state = await this.snapshot();
    if (!state.command && hasPendingCompatibility(this)) throw Error('치수 연관 설정 복원이 완료되지 않았습니다. 진행 중 작업을 정리한 뒤 다시 시도해 주세요.');
    if (state.modal || state.text_editor || state.mtext_editor || (state.command && !isOwnedCommand(this, state))) throw new Error('편집기의 진행 중 명령이나 대화상자를 먼저 닫아 주세요.');
    const header = await this.request({ op: 'header' });
    const query = await this.request({ op: 'query', detail: 'full', offset: 0, limit: 80 });
    const latest = await this.snapshot();
    if (state.document_id !== latest.document_id || state.revision !== latest.revision ||
      state.geometry_revision !== latest.geometry_revision || state.layout !== latest.layout ||
      JSON.stringify(state.command) !== JSON.stringify(latest.command) || (state.command && !isOwnedCommand(this, latest)) ||
      !sameSelection(state.selection || [], latest.selection || [])) throw new Error('도면이나 선택이 변경되었습니다. 다시 보내 주세요.');
    this.units = header.insertion_units;
    return { documentId: state.document_id, revision: state.revision, units: this.units,
      ...(Number.isSafeInteger(state.geometry_revision) ? { geometryRevision: state.geometry_revision } : {}),
      ...(typeof state.layout === 'string' ? { layout: state.layout } : {}),
      command: state.command ?? null, selection: state.selection || [], entities: (query.entities || []).map(e => ({
        handle: e.handle, type: e.type, layer: e.layer, bounds: e.bounds
      })) };
  }

  handles(operation, state) {
    const handles = operation.target === 'last' && this.lastDocument === state.document_id
      ? this.lastHandles : state.selection;
    if (!handles?.length || handles.length > 100) throw new Error('먼저 수정하거나 측정할 객체를 선택해 주세요.');
    return handles;
  }

  async executePlan(plan, { signal } = {}) {
    let state = await this.snapshot();
    const base = plan.base;
    if (!base || state.document_id !== base.documentId || state.revision !== base.revision ||
      !sameSelection(state.selection || [], base.selection || [])) {
      throw new Error('도면이나 선택이 변경되었습니다. 요청을 다시 보내 주세요.');
    }
    const header = await this.request({ op: 'header' });
    if (header.insertion_units !== base.units) throw new Error('도면 단위가 변경되었습니다. 요청을 다시 보내 주세요.');
    if (!Array.isArray(plan.operations) || plan.operations.length > 8) throw new Error('잘못된 CAD 작업 목록입니다.');
    if (plan.operations.some(op => op.type === 'quantity_review') && plan.operations.length !== 1) {
      throw new Error('물량검토와 도면 수정은 각각 요청해 주세요.');
    }
    if (!plan.operations.length) return { message: plan.reply, details: [] };
    const scale = mmPerUnit(base.units);
    const details = [];
    const reports = [];
    let completed = 0;
    let writeAttempted = false;
    try {
      for (const operation of plan.operations) {
        if (signal?.aborted) throw new Error('작업을 취소했습니다.');
        if (['rectangle', 'circle', 'line'].includes(operation.type)) {
          writeAttempted = true;
          const reply = await this.mutate({ op: 'entities_create',
            entities: [entityDefinition(operation, base.units)] }, state);
          const handles = reply.result?.handles;
          if (reply.result?.created !== 1 || !handles?.length) throw new Error('객체 생성 결과를 확인하지 못했습니다.');
          this.lastHandles = handles; this.lastDocument = state.document_id;
          const check = await this.request({ op: 'query', handles, detail: 'full' });
          if (check.entities?.length !== 1) throw new Error('생성 객체를 다시 읽지 못했습니다.');
          details.push(`생성 완료 · ${operation.type === 'rectangle' ? '사각형' : operation.type === 'circle' ? '원' : '선'} · 객체 ${handles.join(', ')}`);
        } else if (operation.type === 'move') {
          const handles = this.handles(operation, state);
          const vector = [number(operation.dx_mm) / scale, number(operation.dy_mm) / scale, 0];
          if (!vector[0] && !vector[1]) throw new Error('이동 거리가 0입니다.');
          writeAttempted = true;
          const reply = await this.mutate({ op: 'entities_transform', handles, action: 'move', vector }, state);
          if (reply.result?.affected !== handles.length) throw new Error('이동 대상 개수가 일치하지 않습니다.');
          details.push(`${handles.length}개 객체 이동 완료 · X ${operation.dx_mm}mm / Y ${operation.dy_mm}mm`);
        } else if (operation.type === 'delete') {
          const handles = this.handles(operation, state);
          writeAttempted = true;
          const reply = await this.mutate({ op: 'entities_delete', handles }, state);
          if (reply.result?.erased !== handles.length) throw new Error('삭제 대상 개수가 일치하지 않습니다.');
          const check = await this.request({ op: 'query', handles, detail: 'full' });
          if (check.entities?.length !== 0) throw new Error('삭제 결과를 확인하지 못했습니다.');
          this.lastHandles = [];
          details.push(`${handles.length}개 객체 삭제 완료`);
        } else if (operation.type === 'measure') {
          const handles = this.handles(operation, state);
          const reply = await this.request({ op: 'measure', handles });
          for (const item of reply.measurements || []) {
            const length = item.curve?.length;
            const area = item.curve?.area;
            const values = [];
            if (typeof length === 'number') values.push(`길이 ${(length * scale / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 6 })}m`);
            if (typeof area === 'number') values.push(`면적 ${(area * scale ** 2 / 1_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 6 })}m²`);
            details.push(`객체 ${item.handle} · ${values.join(' / ') || '이 객체는 길이·면적 측정을 지원하지 않습니다.'}`);
          }
          if (!reply.measurements?.length) throw new Error('측정 결과가 없습니다.');
        } else if (operation.type === 'quantity_review') {
          const report = await collectQuantities(this.request.bind(this), scale);
          const latest = await this.snapshot();
          const currentHeader = await this.request({ op: 'header' });
          if (latest.document_id !== state.document_id || latest.revision !== state.revision ||
            latest.layout !== state.layout || currentHeader.insertion_units !== base.units) {
            throw new Error('집계 중 도면이 변경되었습니다. 다시 요청해 주세요.');
          }
          const document = state.documents?.find(d => d.id === state.document_id);
          reports.push({ ...report, documentName: (document?.path || document?.title || '현재 도면').split(/[\\/]/).pop(),
            revision: state.revision });
          details.push(`레이어 ${report.rows.length}개 · 객체 ${report.totals.count}개 물량검토 완료`);
        } else if (operation.type === 'undo') {
          writeAttempted = true;
          await this.mutate({ op: 'undo' }, state); this.lastHandles = [];
          details.push('마지막 변경을 실행 취소했습니다.');
        } else throw new Error('허용되지 않은 CAD 작업입니다.');
        completed++;
        state = await this.snapshot();
      }
      if (writeAttempted && !signal?.aborted) await this.fit();
      return { message: details.join('\n'), details, ...(reports.length ? { reports } : {}) };
    } catch (error) {
      throw new Error(`${error.message}${completed ? ` (${completed}개 작업은 이미 완료되었습니다. 실행 취소로 되돌릴 수 있습니다.)` : writeAttempted ? ' 도면이 변경되었을 수 있습니다. 도면을 확인하고 필요하면 실행 취소 후 다시 요청해 주세요.' : ''}`);
    }
  }

  async save(name, expected) {
    if (hasPendingCompatibility(this)) throw Error('치수 연관 설정 복원이 완료되지 않아 저장할 수 없습니다.');
    if (typeof name !== 'string' || !/^[^/\\\x00-\x1f]{1,150}\.dwg$/i.test(name)) {
      throw new Error('저장 이름은 경로를 제외한 .dwg 파일명이어야 합니다.');
    }
    const state = await this.snapshot();
    const header = await this.request({ op: 'header' });
    if (state.command || state.modal || state.text_editor || state.mtext_editor) throw Error('편집기의 진행 중 명령이나 대화상자를 먼저 닫아 주세요.');
    if (expected && (state.document_id!==expected.documentId || state.revision!==expected.revision ||
      (expected.geometryRevision!=null && state.geometry_revision!==expected.geometryRevision) ||
      (expected.layout!=null && state.layout!==expected.layout) || !sameSelection(state.selection||[],expected.selection||[]) || header.insertion_units!==expected.units)) throw Error('도면이나 단위가 변경되어 저장을 중단했습니다.');
    const verify = async (allowSaveRevision=false) => {
      const units=await this.request({op:'header'});
      const current=await this.snapshot();
      if (current.document_id!==state.document_id || (!allowSaveRevision && current.revision!==state.revision) ||
        current.geometry_revision!==state.geometry_revision || current.layout!==state.layout ||
        !sameSelection(current.selection||[],state.selection||[]) || units.insertion_units!==header.insertion_units ||
        current.command || current.modal || current.text_editor || current.mtext_editor) throw Error('저장 중 도면이나 단위가 변경되었습니다. 저장 결과를 사용할 수 없습니다.');
      return current;
    };
    const georeferences = await readGeoreferences(this, state, header.insertion_units);
    const audit = await this.request({ op: 'audit' });
    const version = audit.source?.format === 'dwg' ? audit.source.version : this.sourceVersion || 'AC1032';
    const check = await this.request({ op: 'audit', target_format: 'dwg', target_version: version });
    if (check.summary?.errors !== 0 || check.target?.dropped_on_save > 0) throw new Error('데이터 손실 가능성이 있어 저장을 중단했습니다.');
    await verify();
    const reply = await this.mutate({ op: 'save', name, target_format: 'dwg', target_version: version }, state);
    const after=await verify(true);
    if (reply.state && ['document_id','revision','geometry_revision','layout','selection'].some(key=>JSON.stringify(reply.state[key])!==JSON.stringify(after[key]))) throw Error('DWG 저장 응답과 현재 도면이 일치하지 않습니다.');
    const result = reply.result;
    if (!result || result.dropped_on_save !== 0 || !result.data_base64 || result.bytes > MAX_FILE_BYTES) {
      throw new Error('손실 없는 DWG 저장 결과를 확인하지 못했습니다.');
    }
    const bytes = fromBase64(result.data_base64);
    if (bytes.length !== result.bytes || new TextDecoder().decode(bytes.slice(0, 6)) !== version) {
      throw new Error('저장된 DWG의 크기 또는 버전이 올바르지 않습니다.');
    }
    return { name, bytes, version, georeferences, audit: { errors: check.summary.errors, droppedOnSave: result.dropped_on_save } };
  }
}
