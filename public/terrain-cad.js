import { mmPerUnit } from './units.js';
import { GEO_LAYER, parseGeoReference, metadataText } from './geo-reference.js';
import { guardedState, stateMatches, sameAnchor, near, pointCoordinates, readGeoreferences } from './parcel-cad.js';

const fail = message => { throw new Error(message); };
const cancelled = signal => { if (signal?.aborted) fail('작업을 취소했습니다.'); };
const bounded = value => Number.isFinite(value) && Math.abs(value) <= 100_000_000;
const textValue = entity => entity.properties?.value ?? entity.value;
const coordinate = (point, scale, z) => {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(bounded)) fail('지형 좌표가 올바르지 않습니다.');
  return [point[0] / scale, point[1] / scale, z];
};

function checkedPlan(plan, units) {
  const metadata = parseGeoReference(plan?.metadata);
  if (!metadata || metadata.kind !== 'terrain' || metadata.units !== units) fail('지형 공간 기준의 도면 단위가 일치하지 않습니다.');
  if (!Array.isArray(plan.entities) || !plan.entities.length || plan.entities.length > 500) fail('지형 객체 개수가 올바르지 않습니다.');
  const scale = mmPerUnit(units); const entities = [];
  let pointCount = 0; let contourCount = 0; let spotCount = 0; let min = Infinity; let max = -Infinity;
  const label = (position, elevation) => ({ type: 'Text', layer: 'VWORLD_TERRAIN_LABELS', position, height: 1000 / scale, value: `${elevation}m` });
  for (const feature of plan.entities) {
    if (!feature || !Number.isFinite(feature.elevationM) || feature.elevationM < -1000 || feature.elevationM > 10000) fail('지형 표고가 올바르지 않습니다.');
    min = Math.min(min, feature.elevationM); max = Math.max(max, feature.elevationM);
    const z = feature.elevationM * 1000 / scale;
    if (feature.kind === 'contour') {
      if (!Array.isArray(feature.verticesMm) || typeof feature.closed !== 'boolean' || feature.verticesMm.length < (feature.closed ? 3 : 2)) fail('등고선 형식이 올바르지 않습니다.');
      pointCount += feature.verticesMm.length;
      if (pointCount > 20000) fail('지형 좌표 개수가 허용 범위를 넘었습니다.');
      const vertices = feature.verticesMm.map(point => coordinate(point, scale, z));
      const count = vertices.length - (feature.closed ? 0 : 1);
      for (let i = 0; i < count; i++) {
        const start = vertices[i]; const end = vertices[(i + 1) % vertices.length];
        if (start[0] === end[0] && start[1] === end[1]) fail('등고선에 중복된 꼭짓점이 있습니다.');
        // shortcut: the current engine discards LwPolyline Z, use 3D Line segments until it supports elevated polylines.
        entities.push({ type: 'Line', layer: 'VWORLD_CONTOURS', start, end });
      }
      entities.push(label(vertices[0], feature.elevationM)); contourCount++;
    } else if (feature.kind === 'spot') {
      pointCount++;
      if (pointCount > 20000) fail('지형 좌표 개수가 허용 범위를 넘었습니다.');
      const location = coordinate(feature.positionMm, scale, z);
      entities.push({ type: 'Point', layer: 'VWORLD_ELEVATIONS', location }, label(location, feature.elevationM)); spotCount++;
    } else fail('허용되지 않은 지형 객체입니다.');
  }
  const summary = plan.summary; const terrain = metadata.terrain;
  if (!summary || ['featureCount', 'sourceCRS', 'targetCRS', 'units', 'mmPerUnit', 'metresToDrawingUnits', 'modelScale', 'possiblyTruncated'].some(key => summary[key] !== metadata[key]) ||
    summary.contourCount !== contourCount || terrain.contourCount !== contourCount || summary.spotCount !== spotCount || terrain.spotCount !== spotCount ||
    !near(summary.minElevationM, min) || !near(summary.maxElevationM, max) || !near(terrain.minElevationM, min) || !near(terrain.maxElevationM, max)) fail('지형 객체 개수 또는 표고 검증에 실패했습니다.');
  entities.push({ type: 'Text', layer: GEO_LAYER, value: metadataText(metadata), position: [...metadata.insertionMm.map(value => value / scale), 0], height: 0.001 / scale });
  return { metadata, summary: { ...summary }, entities };
}

function verifyShape(actual, expected) {
  if (actual.type !== expected.type || actual.layer !== expected.layer) fail('지형 객체의 형식 또는 레이어가 일치하지 않습니다.');
  const properties = actual.properties || actual;
  const equalPoint = (actualPoint, expectedPoint) => {
    const point = pointCoordinates(actualPoint || {});
    if (point.length !== 3 || point.some((value, axis) => !near(value, expectedPoint[axis], 1e-7))) fail('생성한 지형 객체의 XYZ 좌표가 일치하지 않습니다.');
  };
  if (expected.type === 'Line') {
    equalPoint(properties.start, expected.start); equalPoint(properties.end, expected.end);
  } else if (expected.type === 'Point') equalPoint(properties.location, expected.location);
  else {
    equalPoint(properties.position || properties.location || properties.insertion_point, expected.position);
    if (textValue(actual) !== expected.value || !near(properties.height, expected.height, 1e-12)) fail('생성한 표고 또는 공간 기준 정보를 다시 확인하지 못했습니다.');
  }
}

export async function insertTerrain(cad, plan, base, { signal } = {}) {
  const checked = checkedPlan(plan, base?.units);
  const initial = await guardedState(cad, base, signal);
  const existing = await readGeoreferences(cad, initial, base.units);
  if (existing.length && !sameAnchor(existing[0], checked.metadata)) fail('현재 도면과 지형 자료의 공간 기준이 다릅니다.');
  const state = await guardedState(cad, base, signal); let writeAttempted = false;
  try {
    cancelled(signal); writeAttempted = true;
    const reply = await cad.mutate({ op: 'entities_create', entities: checked.entities }, state, { signal });
    const handles = reply.result?.handles;
    if (reply.result?.created !== checked.entities.length || !Array.isArray(handles) || handles.length !== checked.entities.length ||
      new Set(handles).size !== handles.length || handles.some(handle => typeof handle !== 'string' || !/^[a-f\d]{1,16}$/i.test(handle))) fail('지형 객체 생성 개수와 핸들을 확인하지 못했습니다.');
    cad.lastHandles = handles.slice(0, -1); cad.lastDocument = state.document_id;
    const committed = await cad.snapshot();
    if (committed.document_id !== state.document_id || committed.layout !== 'Model') fail('지형 객체 생성 중 도면이 변경되었습니다.');
    for (let offset = 0; offset < handles.length; offset += 200) {
      const pageHandles = handles.slice(offset, offset + 200);
      const query = await cad.request({ op: 'query', handles: pageHandles, detail: 'full', limit: 200 });
      if (!Array.isArray(query.entities) || query.entities.length !== pageHandles.length) fail('생성한 지형 객체를 모두 다시 읽지 못했습니다.');
      const byHandle = new Map(query.entities.map(entity => [entity.handle, entity]));
      if (byHandle.size !== pageHandles.length) fail('지형 객체의 핸들이 일치하지 않습니다.');
      pageHandles.forEach((handle, index) => {
        if (!byHandle.has(handle)) fail('지형 객체의 핸들이 일치하지 않습니다.');
        verifyShape(byHandle.get(handle), checked.entities[offset + index]);
      });
      cancelled(signal);
    }
    if (!stateMatches(committed, await cad.snapshot())) fail('지형 객체 확인 중 도면이 변경되었습니다.');
    cancelled(signal); await cad.fit();
    return { message: '등고선·표고 자료 삽입을 완료했습니다.', georeference: checked.metadata, summary: checked.summary, handles: handles.slice(0, -1),
      details: [`등고선 ${checked.summary.contourCount}개 · 표고점 ${checked.summary.spotCount}개 · 표고 ${checked.summary.minElevationM}~${checked.summary.maxElevationM}m`,
        '필지와 같은 EPSG:5179 기준 · 모델 실척 1:1 · 실제 XYZ 좌표 재조회 검사 완료',
        `수직 기준: ${checked.metadata.terrain.verticalDatum} · 등고선은 Z 좌표가 있는 선분과 표고 문자로 저장했습니다.`] };
  } catch (error) {
    throw new Error(`${error.message}${writeAttempted ? ' 지형 객체가 이미 반영되었거나 도면이 변경되었을 수 있습니다. 현재 도면을 확인해 주세요. 자동 실행 취소는 하지 않았습니다.' : ''}`);
  }
}
