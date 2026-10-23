import { mmPerUnit } from './units.js';
import { GEO_LAYER, OUTER_LAYER, HOLE_LAYER, parseGeoReference, metadataText, ANCHOR_FIELDS } from './geo-reference.js';

const fail = message => { throw new Error(message); };
const cancelled = signal => { if (signal?.aborted) fail('작업을 취소했습니다.'); };
export const sameAnchor = (a, b) => ANCHOR_FIELDS.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
export const near = (a, b, absolute = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(absolute, Math.abs(b) * 1e-8);
const textValue = entity => entity.properties?.value ?? entity.value;

export function stateMatches(a, b) {
  return a.document_id === b.document_id && a.revision === b.revision && a.layout === b.layout &&
    a.geometry_revision === b.geometry_revision &&
    JSON.stringify([...(a.selection || [])].sort()) === JSON.stringify([...(b.selection || [])].sort());
}

export async function guardedState(cad, base, signal) {
  cancelled(signal);
  await cad.executePlan({ base, operations: [] });
  const state = await cad.snapshot();
  if (state.document_id !== base.documentId || state.revision !== base.revision ||
    JSON.stringify([...(state.selection || [])].sort()) !== JSON.stringify([...(base.selection || [])].sort())) fail('도면이나 선택이 변경되었습니다.');
  if (state.layout !== 'Model') fail('필지 경계는 모델 공간에서만 삽입할 수 있습니다.');
  if (state.modal || state.command) fail('진행 중인 명령이나 대화상자를 먼저 닫아 주세요.');
  cancelled(signal);
  return state;
}

export async function readGeoreferences(cad, state, units) {
  const metadata = [];
  const seen = new Set();
  let offset = 0; let total; let geometryRevision = state.geometry_revision;
  for (let page = 0; page < 501; page++) {
    const reply = await cad.request({ op: 'query', detail: 'full', offset, limit: 200 });
    if (!Array.isArray(reply.entities) || reply.entities.length > 200 || reply.document_id !== state.document_id ||
      !Number.isSafeInteger(reply.geometry_revision) || (geometryRevision != null && reply.geometry_revision !== geometryRevision)) fail('공간 기준 조회 중 도면이 변경되었습니다.');
    geometryRevision = reply.geometry_revision;
    if (!Number.isSafeInteger(reply.count) || reply.count < 0 || reply.returned !== reply.entities.length ||
      (total != null && total !== reply.count) || offset + reply.returned > reply.count) fail('공간 기준 조회의 객체 개수가 올바르지 않습니다.');
    total = reply.count;
    for (const entity of reply.entities) {
      if (typeof entity.handle !== 'string' || seen.has(entity.handle.toUpperCase())) fail('공간 기준 조회에 중복되거나 잘못된 객체가 있습니다.');
      seen.add(entity.handle.toUpperCase());
      if (entity.layer !== GEO_LAYER) continue;
      if (entity.type !== 'Text') fail('도면의 공간 기준 레이어가 손상되었습니다.');
      const parsed = parseGeoReference(textValue(entity));
      if (!parsed) fail('도면의 공간 기준 정보가 손상되었습니다.');
      if (parsed.units !== units) fail('도면 단위와 공간 기준 단위가 다릅니다.');
      if (metadata.length && !sameAnchor(metadata[0], parsed)) fail('도면의 공간 기준이 서로 일치하지 않습니다.');
      if (metadata.length >= 1000) fail('도면의 공간 기준 정보 개수가 허용 범위를 넘었습니다.');
      metadata.push(parsed);
    }
    if (reply.next_offset == null) {
      if (offset + reply.entities.length !== reply.count) fail('공간 기준 조회가 일부만 반환되었습니다.');
      if (!stateMatches(state, await cad.snapshot())) fail('공간 기준 조회 중 도면이 변경되었습니다.');
      return metadata;
    }
    if (!Number.isSafeInteger(reply.next_offset) || reply.next_offset !== offset + reply.entities.length || reply.next_offset <= offset || reply.next_offset >= total) {
      fail('공간 기준 조회의 페이지 정보가 올바르지 않습니다.');
    }
    offset = reply.next_offset;
  }
  fail('도면이 너무 커서 공간 기준을 모두 확인하지 못했습니다.');
}

export async function parcelContext(cad, base, { signal } = {}) {
  const state = await guardedState(cad, base, signal);
  const metadata = await readGeoreferences(cad, state, base.units);
  const context = await cad.context();
  await guardedState(cad, base, signal);
  return { georeference: metadata[0] || null, context };
}

function ringMetrics(vertices) {
  let twiceArea = 0; let length = 0;
  const origin = vertices[0];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]; const b = vertices[(i + 1) % vertices.length];
    const edge = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!edge) fail('필지 경계에 중복된 꼭짓점이 있습니다.');
    length += edge;
    twiceArea += (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);
  }
  const area = Math.abs(twiceArea) / 2;
  if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(length)) fail('필지 경계 면적이 올바르지 않습니다.');
  return { length, area };
}

function checkedPlan(plan, units) {
  const metadata = parseGeoReference(plan?.metadata);
  if (!metadata || metadata.units !== units) fail('필지 공간 기준의 도면 단위가 일치하지 않습니다.');
  const scale = mmPerUnit(units);
  if (!Array.isArray(plan.rings) || !plan.rings.length || plan.rings.length > 200) fail('필지 경계 개수가 올바르지 않습니다.');
  let vertexCount = 0; let netArea = 0; let outerCount = 0;
  const metrics = [];
  const entities = plan.rings.map(ring => {
    if (!ring || !['outer', 'hole'].includes(ring.role) || !Array.isArray(ring.verticesMm) || ring.verticesMm.length < 3 ||
      (ring.pnu != null && (typeof ring.pnu !== 'string' || !/^\d{19}$/.test(ring.pnu)))) fail('필지 경계 형식이 올바르지 않습니다.');
    vertexCount += ring.verticesMm.length;
    if (vertexCount > 20_000) fail('필지 경계 꼭짓점 개수가 허용 범위를 넘었습니다.');
    const vertices = ring.verticesMm.map(point => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(value => Number.isFinite(value) && Math.abs(value) <= 100_000_000)) fail('필지 경계 좌표가 올바르지 않습니다.');
      return [point[0] / scale, point[1] / scale, 0];
    });
    const metric = ringMetrics(ring.verticesMm);
    metrics.push(metric); netArea += (ring.role === 'outer' ? 1 : -1) * metric.area / 1e6;
    if (ring.role === 'outer') outerCount++;
    return { type: 'LwPolyline', layer: ring.role === 'outer' ? OUTER_LAYER : HOLE_LAYER, vertices, closed: true };
  });
  const summary = plan.summary;
  if (!summary || summary.ringCount !== entities.length || summary.ringCount !== metadata.ringCount ||
    summary.outerRingCount !== outerCount || summary.holeRingCount !== entities.length - outerCount || !outerCount ||
    ['featureCount', 'sourceCRS', 'targetCRS', 'units', 'mmPerUnit', 'metresToDrawingUnits', 'modelScale', 'possiblyTruncated'].some(key => summary[key] !== metadata[key]) ||
    !near(summary.netAreaM2, metadata.netAreaM2) || !near(netArea, metadata.netAreaM2)) fail('필지 경계의 개수 또는 면적 검증에 실패했습니다.');
  entities.push({ type: 'Text', layer: GEO_LAYER, value: metadataText(metadata),
    position: [...metadata.insertionMm.map(value => value / scale), 0], height: 0.001 / scale });
  return { metadata, summary: { ...summary }, entities, metrics, scale };
}

export function pointCoordinates(vertex) {
  const point = vertex.location || vertex;
  return Array.isArray(point) ? point : [point.x, point.y, point.z || 0];
}

function verifyShape(actual, expected) {
  const correctType = actual.type === expected.type || (expected.type === 'LwPolyline' && actual.type === 'Polyline');
  if (!correctType || actual.layer !== expected.layer) fail('생성 객체의 형식 또는 레이어가 일치하지 않습니다.');
  const properties = actual.properties || actual;
  if (expected.type === 'Text') {
    if (textValue(actual) !== expected.value || !near(properties.height, expected.height, 1e-12)) fail('생성한 공간 기준 정보를 다시 확인하지 못했습니다.');
    const position = pointCoordinates(properties.position || properties.location || properties.insertion_point || {});
    if (position.some((value, i) => !near(value, expected.position[i], 1e-7))) fail('공간 기준 위치가 일치하지 않습니다.');
    parseGeoReference(textValue(actual));
    return;
  }
  const closed = properties.is_closed === true || properties.closed === true || (Number.isInteger(properties.flags?.bits) && (properties.flags.bits & 1) === 1);
  if (!closed || !Array.isArray(properties.vertices) || properties.vertices.length !== expected.vertices.length) fail('생성한 필지 경계가 닫혀 있지 않거나 꼭짓점 수가 다릅니다.');
  properties.vertices.forEach((vertex, index) => {
    if (vertex.bulge != null && vertex.bulge !== 0) fail('필지 경계에 예상하지 않은 곡선이 포함되었습니다.');
    const point = pointCoordinates(vertex);
    if (point.length !== 3 || point.some((value, axis) => !near(value, expected.vertices[index][axis], 1e-7))) fail('생성한 필지 경계 좌표가 일치하지 않습니다.');
  });
}

async function verifyCreated(cad, handles, checked, committed) {
  const reply = await cad.request({ op: 'query', handles, detail: 'full' });
  if (!Array.isArray(reply.entities) || reply.entities.length !== handles.length) fail('생성한 필지 객체를 모두 다시 읽지 못했습니다.');
  for (let i = 0; i < handles.length; i++) {
    const matches = reply.entities.filter(entity => entity.handle === handles[i]);
    if (matches.length !== 1) fail('생성 객체의 핸들이 일치하지 않습니다.');
    verifyShape(matches[0], checked.entities[i]);
  }
  const polylineHandles = handles.slice(0, -1);
  const measured = await cad.request({ op: 'measure', handles: polylineHandles });
  if (!Array.isArray(measured.measurements) || measured.measurements.length !== polylineHandles.length) fail('필지 경계 측정 결과가 누락되었습니다.');
  for (let i = 0; i < polylineHandles.length; i++) {
    const matches = measured.measurements.filter(item => item.handle === polylineHandles[i]);
    const curve = matches[0]?.curve;
    if (matches.length !== 1 || curve?.closed !== true || !near(curve.length * checked.scale, checked.metrics[i].length) ||
      !near(Math.abs(curve.area) * checked.scale ** 2, checked.metrics[i].area, 0.001)) fail('필지 경계의 실제 길이 또는 면적이 투영 결과와 다릅니다.');
  }
  if (!stateMatches(committed, await cad.snapshot())) fail('필지 경계 확인 중 도면이 변경되었습니다.');
  return polylineHandles;
}

export async function insertParcels(cad, plan, base, { signal } = {}) {
  const checked = checkedPlan(plan, base?.units);
  const initial = await guardedState(cad, base, signal);
  const existing = await readGeoreferences(cad, initial, base.units);
  if (existing.length && !sameAnchor(existing[0], checked.metadata)) fail('현재 도면의 공간 기준과 필지의 공간 기준이 다릅니다.');
  const state = await guardedState(cad, base, signal);
  let writeAttempted = false;
  try {
    cancelled(signal);
    writeAttempted = true;
    const reply = await cad.mutate({ op: 'entities_create', entities: checked.entities }, state, { signal });
    const handles = reply.result?.handles;
    if (reply.result?.created !== checked.entities.length || !Array.isArray(handles) || handles.length !== checked.entities.length ||
      new Set(handles).size !== handles.length || handles.some(handle => typeof handle !== 'string' || !/^[a-f\d]{1,16}$/i.test(handle))) fail('필지 객체 생성 개수와 핸들을 확인하지 못했습니다.');
    cad.lastHandles = handles.slice(0, -1); cad.lastDocument = state.document_id;
    const committed = await cad.snapshot();
    if (committed.document_id !== state.document_id || committed.layout !== 'Model') fail('필지 경계 생성 중 도면이 변경되었습니다.');
    const polylineHandles = await verifyCreated(cad, handles, checked, committed);
    cancelled(signal);
    await cad.fit();
    const details = [`외곽 ${checked.summary.outerRingCount}개 · 내부 경계 ${checked.summary.holeRingCount}개 · 순면적 ${checked.summary.netAreaM2.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}m²`,
      'EPSG:4326 → EPSG:5179 · 모델 실척 1:1 · 경계 재조회 및 길이·면적 검사 완료'];
    return { message: '필지 경계 삽입을 완료했습니다.', details, georeference: checked.metadata, summary: checked.summary, handles: polylineHandles };
  } catch (error) {
    throw new Error(`${error.message}${writeAttempted ? ' 필지 객체가 이미 반영되었거나 도면이 변경되었을 수 있습니다. 현재 도면을 확인해 주세요. 자동 실행 취소는 하지 않았습니다.' : ''}`);
  }
}
