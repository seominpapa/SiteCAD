const PAGE_SIZE = 200;
const SCOPE = '모형 공간의 최상위 객체 · 블록 내부·배치 제외 · 폐합 곡선 면적';
const VWORLD_BOUNDARIES = new Set(['VWORLD_PARCELS', 'VWORLD_HOLES']);
const TERRAIN_LAYERS = new Set(['VWORLD_CONTOURS', 'VWORLD_ELEVATIONS']);

function numericHandle(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('객체 소유 핸들을 정확히 읽지 못했습니다.');
  return value.toString(16).toUpperCase();
}

function handle(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) throw new Error('객체 핸들이 올바르지 않습니다.');
  return BigInt(`0x${value}`).toString(16).toUpperCase();
}

function owner(properties) {
  if (!properties || typeof properties !== 'object') return undefined;
  if (properties.common && Object.hasOwn(properties.common, 'owner_handle')) return properties.common.owner_handle;
  // Dimension variants wrap their common metadata in Linear.base (or another variant).
  for (const value of Object.values(properties)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = owner(value);
      if (found !== undefined) return found;
    }
  }
}

const emptyRow = layer => ({ ...(layer === undefined ? {} : { layer }), count: 0,
  lengthM: null, areaM2: null, lengthCount: 0, areaCount: 0, unmeasuredCount: 0 });

function add(row, values) {
  const lengthM = values.lengthM === null ? row.lengthM : (row.lengthM ?? 0) + values.lengthM;
  const areaM2 = values.areaM2 === null ? row.areaM2 : (row.areaM2 ?? 0) + values.areaM2;
  if ((lengthM !== null && !Number.isFinite(lengthM)) || (areaM2 !== null && !Number.isFinite(areaM2))) {
    throw new Error('측정 합계가 유효한 숫자 범위를 벗어났습니다.');
  }
  return { ...row, count: row.count + 1, lengthM, areaM2,
    lengthCount: row.lengthCount + Number(values.lengthM !== null),
    areaCount: row.areaCount + Number(values.areaM2 !== null),
    unmeasuredCount: row.unmeasuredCount + Number(values.lengthM === null && values.areaM2 === null) };
}

function value(value, scale) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * scale)) {
    throw new Error('유효하지 않은 측정값이 있어 집계를 중단했습니다.');
  }
  return value * scale;
}

export async function collectQuantities(request, scaleMm) {
  if (!Number.isFinite(scaleMm) || scaleMm <= 0) throw new Error('도면 단위를 확인한 뒤 물량검토를 요청해 주세요.');
  let documentId;
  let geometryRevision;
  function verify(reply) {
    if (!reply?.ok || !Number.isSafeInteger(reply.document_id) || !Number.isSafeInteger(reply.geometry_revision)) {
      throw new Error('집계 응답을 확인하지 못했습니다.');
    }
    if (documentId === undefined) { documentId = reply.document_id; geometryRevision = reply.geometry_revision; }
    if (reply.document_id !== documentId || reply.geometry_revision !== geometryRevision) {
      throw new Error('집계 중 도면이 변경되었습니다. 다시 요청해 주세요.');
    }
  }
  async function pages(operation, field) {
    let rows = [];
    let count;
    let offset = 0;
    for (;;) {
      const reply = await request({ ...operation, offset, limit: PAGE_SIZE });
      verify(reply);
      if (!Array.isArray(reply[field]) || !Number.isSafeInteger(reply.count) || reply.count < 0 ||
        reply.returned !== reply[field].length || (count !== undefined && count !== reply.count)) {
        throw new Error('객체 목록의 집계 범위를 확인하지 못했습니다.');
      }
      count = reply.count;
      rows = rows.concat(reply[field]);
      const next = offset + reply.returned;
      if (next > count || (reply.next_offset === null ? next !== count
        : reply.next_offset !== next || next <= offset || next >= count)) {
        throw new Error('객체 목록에 누락되거나 중복된 페이지가 있습니다.');
      }
      if (reply.next_offset === null) return rows;
      offset = next;
    }
  }
  const blocks = await pages({ op: 'records', collection: 'block_records' }, 'records');
  const models = blocks.filter(block => block.name?.toUpperCase() === '*MODEL_SPACE');
  if (models.length !== 1) throw new Error('모형 공간 정보를 확인하지 못해 집계를 중단했습니다.');
  const model = handle(models[0].handle);
  const owners = new Set(blocks.map(block => handle(block.handle)));
  const excluded = new Set(blocks.filter(block => block !== models[0]).flatMap(block =>
    (block.properties?.entity_handles || []).map(numericHandle)));
  const queried = await pages({ op: 'query', detail: 'full' }, 'entities');
  const seen = new Set();
  const entities = queried.filter(entity => {
    const id = handle(entity.handle);
    if (seen.has(id)) throw new Error('중복 객체가 있어 집계를 중단했습니다.');
    seen.add(id);
    if (excluded.has(id)) return false;
    const own = numericHandle(owner(entity.properties));
    if (own !== '0' && !owners.has(own)) throw new Error('객체 소유 공간을 확인하지 못했습니다.');
    if (own !== '0' && own !== model) return false;
    if (typeof entity.layer !== 'string') throw new Error('객체의 레이어를 확인하지 못했습니다.');
    return !['SITECAD_GEOREF', 'VWORLD_TERRAIN_LABELS'].includes(entity.layer.toUpperCase());
  });
  const rows = new Map();
  let totals = emptyRow();
  for (let offset = 0; offset < entities.length; offset += PAGE_SIZE) {
    const batch = entities.slice(offset, offset + PAGE_SIZE);
    const reply = await request({ op: 'measure', handles: batch.map(entity => entity.handle) });
    verify(reply);
    if (!Array.isArray(reply.measurements) || reply.measurements.length !== batch.length) {
      throw new Error('측정 결과에 누락된 객체가 있습니다.');
    }
    const measured = new Map();
    for (const item of reply.measurements) {
      const id = handle(item?.handle);
      if (measured.has(id)) throw new Error('측정 결과에 중복 객체가 있습니다.');
      measured.set(id, item);
    }
    for (const entity of batch) {
      const item = measured.get(handle(entity.handle));
      if (!item) throw new Error('측정 결과의 객체가 요청과 다릅니다.');
      const values = { lengthM: value(item.curve?.length, scaleMm / 1000),
        areaM2: item.curve?.closed === true && !VWORLD_BOUNDARIES.has(entity.layer.toUpperCase()) && !TERRAIN_LAYERS.has(entity.layer.toUpperCase())
          ? value(item.curve.area, (scaleMm / 1000) ** 2) : null };
      rows.set(entity.layer, add(rows.get(entity.layer) || emptyRow(entity.layer), values));
      totals = add(totals, values);
    }
  }
  const scope = SCOPE + (entities.some(entity => VWORLD_BOUNDARIES.has(entity.layer.toUpperCase()))
    ? ' · VWorld 경계 면적 제외(삽입 결과 순면적 참고), 경계 길이는 자재 물량 아님' : '') +
    (entities.some(entity => TERRAIN_LAYERS.has(entity.layer.toUpperCase())) ? ' · 지형 면적 제외, 등고선 길이와 표고점은 자재 물량 아님' : '');
  return { scope, rows: [...rows.values()].sort((a, b) => a.layer.localeCompare(b.layer, 'ko')), totals };
}
