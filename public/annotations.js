import { mmPerUnit } from './units.js';

const FONT = 'AppleGothic.ttf';
const TEXT_STYLE = 'SiteCAD_KO';
const DIM_STYLE = 'SiteCAD_DIM';
const DIM_VALUES = { dimtxt: 2.5, dimasz: 2.5, dimgap: 0.625, dimexo: 0.625, dimexe: 1.25, dimdli: 3.75, dimlfac:1, dimsah: false, annotative: false };
const registered = new WeakSet();
const isText = entity => ['Text', 'MText'].includes(entity.type);
const isGeometry = entity => !['Text', 'MText', 'Dimension'].includes(entity.type) &&
  !['SITECAD_GEOREF', 'SITE_GEOREFERENCE'].includes(entity.layer?.toUpperCase());
const properties = record => record?.properties;
const collision = () => Error('SiteCAD 주석 스타일이 기존 도면의 다른 스타일과 충돌합니다.');
const dimensionBase = entity => Object.entries(entity.properties || {}).find(([key, value]) =>
  ['Linear', 'Aligned', 'Angular2Ln', 'Angular3Pt', 'Radius', 'Diameter', 'Ordinate', 'Arc', 'LargeRadial'].includes(key) && value?.base?.style_name != null);

export function annotationSize(entities, units) {
  const mm = mmPerUnit(units);
  const geometry = entities.filter(isGeometry);
  const bounds = geometry.map(entity => entity.bounds).filter(bounds => bounds &&
    [...bounds.min.slice(0, 2), ...bounds.max.slice(0, 2)].every(Number.isFinite));
  const span = bounds.length ? Math.max(...[0, 1].map(axis => Math.max(...bounds.map(b => b.max[axis])) - Math.min(...bounds.map(b => b.min[axis])))) : 0;
  const spanMm = span > 0 ? Math.min(span * mm, Number.MAX_VALUE * Math.min(1, mm) / 100) : 1000;
  const target = Math.max(0.01, spanMm / 200);
  const power = 10 ** Math.floor(Math.log10(target));
  const paperScale = [1, 2, 5, 10].find(value => value * power >= target) * power;
  const modelScale = paperScale / mm;
  return { paperScale, modelScale, textHeight: 2.5 * modelScale };
}

async function read(cad, request, io) {
  const reply = await cad.request(request);
  await io.check();
  if (!reply?.ok) throw Error('주석을 준비할 도면 정보를 읽을 수 없습니다.');
  return reply;
}
async function write(io, request) {
  const reply = await io.write(request);
  if (!reply?.ok) throw Error('주석 스타일을 적용할 수 없습니다.');
  return reply;
}
async function collect(cad, request, key, io) {
  let values = [], offset = 0;
  for (;;) {
    const reply = await read(cad, { ...request, limit: 200, offset }, io);
    if (!Array.isArray(reply[key]) || reply[key].length > 200) throw Error('도면 주석 조회 범위를 확인해 주세요.');
    values = [...values, ...reply[key]];
    if (values.length > 10000 || (values.length === 10000 && reply.next_offset != null)) throw Error('도면 주석 자동 크기 조회 범위를 초과했습니다.');
    if (reply.next_offset == null) return values;
    if (!Number.isInteger(reply.next_offset) || reply.next_offset <= offset) throw Error('도면 주석 조회 범위를 확인해 주세요.');
    offset = reply.next_offset;
  }
}
const styles = (cad, collection, io) => collect(cad, { op: 'records', collection }, 'records', io);
const allDrawing = (cad, io) => collect(cad, { op: 'query', detail: 'full' }, 'entities', io);
const named = (records, name) => records.find(record => record.name?.toUpperCase() === name.toUpperCase());
async function drawing(cad, io) {
  if (io.layout && io.layout !== 'Model') throw Error('주석 자동 크기는 모델 공간에서 적용해 주세요.');
  const entities = await allDrawing(cad, io);
  const model = named(await styles(cad, 'block_records', io), '*MODEL_SPACE');
  const handle = parseInt(model?.handle, 16);
  if (!Number.isSafeInteger(handle) || handle <= 0) throw Error('모델 공간의 주석 범위를 확인할 수 없습니다.');
  return entities.filter(entity => {
    const p = properties(entity);
    const common = p?.common || Object.values(p || {}).find(value => value?.base?.common)?.base.common;
    return common?.owner_handle === handle;
  });
}
const validTextStyle = record => properties(record)?.font_file?.toLowerCase() === FONT.toLowerCase() &&
  properties(record).width_factor === 1 && properties(record).height === 0 && properties(record).big_font_file === '';

async function sizeFor(cad, entities, units, io) {
  const record = named(await styles(cad, 'dim_styles', io), DIM_STYLE);
  if (!record) return annotationSize(entities, units);
  const p = properties(record);
  if (!Number.isFinite(p?.dimscale) || p.dimscale <= 0 || !Number.isFinite(p.dimscale * Math.max(2.5, mmPerUnit(units))) || Object.entries(DIM_VALUES).some(([key, value]) => p[key] !== value)) throw collision();
  return { paperScale: p.dimscale * mmPerUnit(units), modelScale: p.dimscale, textHeight: p.dimscale * 2.5 };
}

async function ensureFont(cad, io, owned = []) {
  const existing = named(await styles(cad, 'text_styles', io), TEXT_STYLE);
  if (existing && !validTextStyle(existing)) throw collision();
  if (!registered.has(cad)) {
    const response = await fetch('/api/cad-font');
    await io.check();
    if (!response.ok || Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw Error('한글 CAD 글꼴을 불러올 수 없습니다.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    await io.check();
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('한글 CAD 글꼴 파일 크기를 확인해 주세요.');
    let raw = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    await write(io, { op: 'font_register', file_name: FONT, data_base64: btoa(raw) });
    registered.add(cad);
  }
  if (!existing) {
    await write(io, { op: 'run', cmd: `STYLE NEW ${TEXT_STYLE}` });
    await write(io, { op: 'run', cmd: `STYLE FONT ${TEXT_STYLE} ${FONT}` });
  }
  if (cad.createdDocumentId != null && (await read(cad, { op: 'state' }, io)).document_id === cad.createdDocumentId) {
    const entities = await allDrawing(cad, io);
    if (entities.every(entity => owned.includes(entity.handle) || ['Line','Arc','Circle','Ellipse','LwPolyline','Polyline','Spline','Point','Solid','Hatch'].includes(entity.type))) {
      const standard = named(await styles(cad, 'text_styles', io), 'Standard');
      if (standard && properties(standard).font_file !== FONT) await write(io, { op: 'run', cmd: `STYLE FONT Standard ${FONT}` });
    }
  }
  const records = await styles(cad, 'text_styles', io);
  if (!validTextStyle(named(records, TEXT_STYLE))) throw collision();
  return records;
}

export async function prepareText(cad, request, units, io) {
  if (request.op !== 'entities_create' || !request.entities?.some(isText)) return { request, annotation: null };
  const automatic = request.entities.some(entity => isText(entity) && entity.height == null);
  const size = automatic ? await sizeFor(cad, await drawing(cad, io), units, io) : null;
  const defaultFont = request.entities.some(entity => isText(entity) && entity.style == null);
  if (defaultFont) await ensureFont(cad, io);
  return { request: { ...request, entities: request.entities.map(entity => isText(entity) ?
    { ...entity, style: entity.style ?? TEXT_STYLE, height: entity.height ?? size.textHeight } : entity) },
  annotation: size || defaultFont ? { ...size, ...(defaultFont ? { font: FONT } : {}) } : null };
}

export async function prepareDimension(cad, handles, units, io) {
  if (!handles.length && !io.prepareOnly) return null;
  if (handles.length > 10000) throw Error('도면 주석 조회 범위를 초과했습니다.');
  const owned = [];
  for (let offset = 0; offset < handles.length; offset += 200) {
    const batch = handles.slice(offset, offset + 200);
    const reply = await read(cad, { op: 'query', handles: batch, detail: 'full', limit: batch.length }, io);
    if (!Array.isArray(reply.entities) || reply.entities.length !== batch.length || new Set(reply.entities.map(entity => entity.handle)).size !== batch.length || reply.entities.some(entity => !batch.includes(entity.handle))) throw Error('생성한 치수 객체를 확인할 수 없습니다.');
    owned.push(...reply.entities.filter(entity => entity.type === 'Dimension'));
  }
  if (!owned.length && !io.prepareOnly) return null;
  const entities = await drawing(cad, io);
  const geometry = entities.filter(isGeometry);
  const size = await sizeFor(cad, geometry.length ? entities : owned.map(entity => ({ ...entity, type: 'Line' })), units, io);
  const textStyles = await ensureFont(cad, io, owned.map(entity => entity.handle));
  const usable = textStyles.find(record => validTextStyle(record) && parseInt(record.handle, 16) > 0) || named(textStyles, 'Standard');
  const textHandle = parseInt(usable?.handle, 16);
  if (!Number.isSafeInteger(textHandle) || textHandle <= 0) throw Error('치수 문자 스타일 핸들을 확인할 수 없습니다.');
  const name = DIM_STYLE;
  const values = { ...DIM_VALUES, dimscale: size.modelScale, dimtxsty: usable.name, dimtxsty_handle: textHandle };
  const dimStyles = await styles(cad, 'dim_styles', io);
  const existing = named(dimStyles, name);
  if (existing && Object.entries(values).some(([key, value]) => properties(existing)?.[key] !== value)) throw collision();
  if (!existing) {
    if (dimStyles.some(record => !parseInt(record.handle, 16))) throw collision();
    await write(io, { op: 'run', cmd: `DIMSTYLE NEW ${name}` });
    const records = await styles(cad, 'dim_styles', io);
    if (records.filter(record => !parseInt(record.handle, 16)).length > 1) throw collision();
    const created = named(records, name);
    if (!created || Object.keys(values).some(key => !(key in properties(created)))) throw Error('치수 스타일 속성을 확인할 수 없습니다.');
    await write(io, { op: 'set_properties', collection: 'dim_styles', name,
      updates: Object.entries(values).map(([key, value]) => ({ path: `/${key}`, expected: properties(created)[key], value })) });
  }
  const applied = named(await styles(cad, 'dim_styles', io), name);
  if (Object.entries(values).some(([key, value]) => properties(applied)?.[key] !== value)) throw collision();
  if (io.prepareOnly) return { ...size, font: properties(usable).font_file, style: name, handles: [] };
  for (const entity of owned) {
    const variant = dimensionBase(entity);
    if (!variant) throw Error('치수 객체의 스타일 속성을 확인할 수 없습니다.');
    await write(io, { op: 'set_properties', collection: 'entities', handle: entity.handle,
      updates: [{ path: `/${variant[0]}/base/style_name`, expected: variant[1].base.style_name, value: name }] });
  }
  for (let offset = 0; offset < owned.length; offset += 200) {
    const handles = owned.slice(offset, offset + 200).map(entity => entity.handle);
    const reply = await read(cad, { op: 'query', handles, detail: 'full', limit: handles.length }, io);
    if (reply.entities?.length !== handles.length || new Set(reply.entities.map(entity => entity.handle)).size !== handles.length || reply.entities.some(entity => !handles.includes(entity.handle) ||
      dimensionBase(entity)?.[1].base.style_name !== name)) throw Error('치수 스타일 적용 결과를 확인할 수 없습니다.');
  }
  return { ...size, font: properties(usable).font_file, style: name, handles: owned.map(entity => entity.handle) };
}
