import { toBase64 } from './cad.js';
import { hasPendingCompatibility } from './cad-control.js';

export async function executeDesktopCad(cad, job, options) {
  if (job.method === 'completion_state') {
    if (hasPendingCompatibility(cad)) throw Error('치수 연관 설정 복원이 완료되지 않아 작업을 완료할 수 없습니다.');
    const before=await cad.snapshot();
    const header=await cad.request({op:'header'});
    const after=await cad.snapshot();
    if (['document_id','revision','geometry_revision','layout','selection','command','modal','text_editor','mtext_editor'].some(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]))) throw Error('작업 완료 확인 중 도면 상태가 변경되었습니다.');
    return {documentId:after.document_id,units:header.insertion_units,command:after.command??null,modal:after.modal??null,textEditor:after.text_editor||null,mtextEditor:after.mtext_editor||null};
  }
  if (['discover','query','control'].includes(job.method)) {
    const result = await cad[job.method](job.payload, options);
    return { ...result, context: await cad.context() };
  }
  if (job.method === 'context') return cad.context();
  if (job.method === 'parcel_context') return cad.parcelContext(job.payload.expectedContext, options);
  if (job.method === 'insert_parcels' || job.method === 'insert_terrain') {
    const result = await (job.method === 'insert_terrain' ? cad.insertTerrain : cad.insertParcels).call(cad, job.payload.plan, job.payload.expectedContext, options);
    return { ...result, context: await cad.context() };
  }
  if (job.method === 'execute') {
    const result = await cad.executePlan({ base: job.payload.expectedContext, operations: job.payload.operations }, options);
    return { ...result, context: await cad.context() };
  }
  if (job.method === 'save') {
    const result = await cad.save(job.payload.name, job.payload.expectedContext);
    return { name: result.name, dataBase64: toBase64(result.bytes), version: result.version,
      audit: result.audit, georeferences: result.georeferences || [], context: await cad.context() };
  }
  throw Error('허용되지 않은 도면 연결 요청입니다.');
}

export async function desktopRequest(path, body = {}) {
  const response = await fetch(`/api/desktop/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error(result.error || 'SiteCAD 연결을 확인해 주세요.');
  return result.data;
}

export function startDesktopBridge(cad, { isReady, onError }) {
  let stopped = false;
  let running;
  let execution;
  let cleanup;
  let generation = 0;
  const pump = async () => {
    while (!stopped) {
      try {
        if (cleanup) { await cleanup; continue; }
        if (!isReady()) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        const job = await desktopRequest('cad/poll');
        if (stopped || !job) continue;
        // An idle poll can span turns; only the server knows whether its job is still current.
        const claimEpoch = generation;
        const claim = await desktopRequest('cad/claim', { id: job.id });
        if (stopped || claimEpoch !== generation || claim?.valid !== true) continue;
        let result; let error;
        try { running = new AbortController(); execution = executeDesktopCad(cad, job, { signal: running.signal }); result = await execution; }
        catch (value) { error = value instanceof Error ? value.message : '도면 작업에 실패했습니다.'; }
        finally { running = undefined; execution = undefined; }
        await desktopRequest('cad/result', { id: job.id, result, error });
      } catch (error) {
        if (!stopped) { onError(error); await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
    }
  };
  void pump();
  const stop = () => { stopped = true; void stop.cancel().catch(onError); };
  stop.cancel = () => {
    generation++; running?.abort();
    if (cleanup) return cleanup;
    const current = execution;
    const pending = (async () => {
      if (current) await current.catch(() => {});
      return cad.cancelPendingCommand ? cad.cancelPendingCommand() : {cancelled:false};
    })();
    cleanup = pending.finally(() => { cleanup = undefined; });
    return cleanup;
  };
  return stop;
}
