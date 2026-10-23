import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import { PROJ_DEFINITION, PUBLIC_TERRAIN_LABEL } from '../public/geo-reference.js';

const SOURCE_URL = 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30185';
const INVALID = '지형 자료의 좌표계·도형·표고 값을 확인해 주세요.';
const CHANGED = '등록한 지형 원본이 변경되었거나 없습니다. 파일을 다시 등록해 주세요.';
const MAX_JSON = 32 * 1024 * 1024;
const MAX_SOURCE = 1024 * 1024 * 1024;
const DOWNLOAD_INVALID = '다운로드한 GeoJSON 원본과 출처 정보를 확인해 주세요.';
proj4.defs('EPSG:5179', PROJ_DEFINITION);

function check(value, message = INVALID) { if (!value) throw new Error(message); }
function numeric(value) { return typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN; }
function elevation(value) { const n = numeric(value); check(Number.isFinite(n) && n >= -500 && n <= 9000); return n; }
function lonLat(point) { return Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[0] >= 124 && point[0] <= 132 && point[1] >= 32 && point[1] <= 39.5; }
function title(path) { return basename(path).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 150); }
function downloadUrl(value) {
  check(typeof value === 'string' && value.length <= 2048, DOWNLOAD_INVALID);
  const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') && !/(^|\.)(localhost|local|internal|home|lan|invalid|test)$/.test(host), DOWNLOAD_INVALID);
  check(![...url.searchParams.keys()].some(key => /key|token|secret|auth|credential|signature|password|session|^sig$/i.test(key)) && !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(decodeURIComponent(url.pathname + url.search)), DOWNLOAD_INVALID);
  return value;
}
function downloadTime(value) { check(typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)), DOWNLOAD_INVALID); return value; }
function checkBbox(bbox) {
  check(Array.isArray(bbox) && bbox.length === 4 && bbox.every(x => typeof x === 'number') && lonLat(bbox.slice(0, 2)) && lonLat(bbox.slice(2)) && bbox[0] < bbox[2] && bbox[1] < bbox[3], '대한민국 경위도 bbox를 입력해 주세요.');
  const width = (bbox[2] - bbox[0]) * 111320 * Math.cos((bbox[1] + bbox[3]) * Math.PI / 360);
  const height = (bbox[3] - bbox[1]) * 111320;
  check(width * height <= 1e6 && width <= 2000 && height <= 2000, '지형 조회 영역은 1km², 각 변은 2km 이하여야 합니다.');
  return [...bbox];
}
function converter(crs) {
  check(typeof crs === 'string' && crs.length > 0 && crs.length <= 4096);
  try { return proj4(crs, 'EPSG:4326'); } catch { throw new Error(INVALID); }
}
function normalized(feature, transform, bbox) {
  check(feature?.type === 'Feature' && feature.geometry && ['Point', 'LineString', 'MultiLineString'].includes(feature.geometry.type));
  const { type, coordinates } = feature.geometry;
  const lines = type === 'Point' ? [[coordinates]] : type === 'LineString' ? [coordinates] : coordinates;
  check(Array.isArray(lines) && lines.length > 0 && lines.length <= 1000);
  let vertices = 0;
  const zValues = [];
  const projected = lines.map(line => {
    check(Array.isArray(line) && line.length >= (type === 'Point' ? 1 : 2) && (vertices += line.length) <= 100000);
    return line.map(point => {
      check(Array.isArray(point) && [2, 3].includes(point.length) && point.every(n => typeof n === 'number' && Number.isFinite(n)));
      const xy = transform.forward(point.slice(0, 2));
      check(lonLat(xy));
      if (point.length === 3) zValues.push(elevation(point[2]));
      return xy;
    });
  });
  const geometry = { type, coordinates: type === 'Point' ? projected[0][0] : type === 'LineString' ? projected[0] : projected };
  const selected = bbox ? clipped({ type: 'Feature', geometry, properties: {} }, bbox) : { geometry };
  if (!selected) return null;
  const values = Object.entries(feature.properties ?? {}).filter(([name, value]) => /^(CONT|HEIGHT|ELE_ALT|elevation_m)$/i.test(name) && value !== null && value !== '').map(([, value]) => elevation(value));
  if (zValues.length) { check(zValues.length === vertices); values.push(...zValues); }
  check(values.length > 0 && values.every(n => Math.abs(n - values[0]) < 1e-6));
  return { type: 'Feature', geometry: selected.geometry, properties: { elevation_m: values[0] } };
}
function inside(point, bbox) { return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]; }
function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }
function sourceEnvelope(transform, bbox) {
  const values = [];
  for (let i = 0; i <= 20; i++) {
    const x = bbox[0] + (bbox[2] - bbox[0]) * i / 20, y = bbox[1] + (bbox[3] - bbox[1]) * i / 20;
    values.push(...[[x, bbox[1]], [x, bbox[3]], [bbox[0], y], [bbox[2], y]].map(point => transform.inverse(point)));
  }
  check(values.every(point => point.every(Number.isFinite)));
  const xs = values.map(point => point[0]), ys = values.map(point => point[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  // shortcut: padded envelope for Korea projections; use a spatial index if broader CRSs are added.
  const pad = Math.max(box[2] - box[0], box[3] - box[1]) * 0.05;
  return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
}
function overlaps(feature, bbox) {
  const geometry = feature?.geometry;
  if (!geometry) return false;
  check(['Point', 'LineString', 'MultiLineString'].includes(geometry.type));
  const lines = geometry.type === 'Point' ? [[geometry.coordinates]] : geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const line of lines) for (const point of line) {
    left = Math.min(left, point[0]); bottom = Math.min(bottom, point[1]); right = Math.max(right, point[0]); top = Math.max(top, point[1]);
  }
  return left <= bbox[2] && right >= bbox[0] && bottom <= bbox[3] && top >= bbox[1];
}
function clipSegment(a, b, box) {
  let lo = 0, hi = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - box[0]], [dx, box[2] - a[0]], [-dy, a[1] - box[1]], [dy, box[3] - a[1]]]) {
    if (p === 0) { if (q < 0) return null; }
    else if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
    if (lo > hi) return null;
  }
  if (lo === hi) return null;
  return [lo === 0 ? a : [a[0] + lo * dx, a[1] + lo * dy], hi === 1 ? b : [a[0] + hi * dx, a[1] + hi * dy]];
}
function clipped(feature, bbox) {
  if (feature.geometry.type === 'Point') return inside(feature.geometry.coordinates, bbox) ? feature : null;
  const input = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const parts = [];
  for (const line of input) {
    let part = [];
    for (let i = 1; i < line.length; i++) {
      const pair = clipSegment(line[i - 1], line[i], bbox);
      if (!pair) { if (part.length > 1) parts.push(part); part = []; continue; }
      if (part.length && same(part.at(-1), pair[0])) part = [...part, pair[1]];
      else { if (part.length > 1) parts.push(part); part = [...pair]; }
    }
    if (part.length > 1) parts.push(part);
  }
  return parts.length ? { ...feature, geometry: { type: parts.length === 1 ? 'LineString' : 'MultiLineString', coordinates: parts.length === 1 ? parts[0] : parts } } : null;
}
async function signatures(paths) {
  return Promise.all(paths.map(async path => {
    const info = await stat(path);
    check(info.isFile() && info.size > 0 && info.size <= MAX_SOURCE);
    return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
  }));
}
async function sha256(paths) {
  const hash = createHash('sha256');
  for (const path of paths) for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function sourcePaths(path) { return extname(path).toLowerCase() === '.shp' ? [path, path.slice(0, -4) + '.dbf', path.slice(0, -4) + '.prj'] : [path]; }
async function geojson(path) {
  check((await stat(path)).size <= MAX_JSON, 'GeoJSON 자료는 32MiB 이하여야 합니다.');
  const data = JSON.parse(await readFile(path, 'utf8'));
  check(data?.exceededTransferLimit !== true, '제공처 조회 제한으로 잘린 지형 원본은 등록할 수 없습니다. 조회 범위를 줄여 주세요.');
  check(data?.type === 'FeatureCollection' && Array.isArray(data.features) && data.features.length > 0 && data.features.length <= 100000);
  const crs = typeof data.crs === 'string' ? data.crs : data.crs?.properties?.name ?? 'EPSG:4326';
  const transform = converter(crs);
  return { crs, features: data.features.map(feature => normalized(feature, transform)) };
}
function guardedShp(path) {
  let header = Buffer.alloc(0), headerSize = 100, remaining = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (remaining) { const count = Math.min(remaining, chunk.length - offset); remaining -= count; offset += count; continue; }
          const count = Math.min(headerSize - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + count)]); offset += count;
          if (header.length !== headerSize) continue;
          if (headerSize === 100) { check(header.readInt32BE(0) === 9994 && header.readInt32LE(28) === 1000); headerSize = 8; }
          else { remaining = header.readInt32BE(4) * 2; check(remaining >= 4 && remaining <= 8 * 1024 * 1024); }
          header = Buffer.alloc(0);
        }
        callback(null, chunk);
      } catch { guard.invalid = true; stream.destroy(); guard.push(null); callback(); }
    },
  });
  const stream = createReadStream(path);
  stream.on('error', () => { guard.invalid = true; guard.push(null); });
  guard.on('close', () => stream.destroy());
  return stream.pipe(guard);
}
async function openSource(record) {
  if (extname(record.path).toLowerCase() !== '.shp') {
    const { features } = await geojson(record.path);
    let index = 0;
    return { read: async () => index < features.length ? { done: false, value: features[index++] } : { done: true }, cancel: async () => {}, normalized: true };
  }
  const guard = guardedShp(record.path);
  const source = await shapefile.open(guard, createReadStream(record.path.slice(0, -4) + '.dbf'), { encoding: 'euc-kr' });
  return { read: async () => { const result = await source.read(); check(!guard.invalid); return result; }, cancel: () => source.cancel() };
}
function publicRecord(record) {
  if (record.sourceKind === 'public-download') return { id: record.id, title: record.title, originalCRS: record.originalCRS, verticalDatum: 'unknown', sourceKind: record.sourceKind, sourceLabel: PUBLIC_TERRAIN_LABEL, sourceUrl: record.sourceUrl, downloadedAt: record.downloadedAt, sourceSha256: record.sourceSha256 };
  return { id: record.id, title: record.title, originalCRS: record.originalCRS, verticalDatum: 'unknown', sourceKind: record.bundled ? 'bundled-vworld-contours' : 'local-file', sourceLabel: record.bundled ? 'VWorld 국토지리정보원 등고선 원본 발췌' : '사용자 등록 원본(원출처 미검증)' };
}
async function inspect(path, bundled = false) {
  check(typeof path === 'string' && isAbsolute(path) && ['.shp', '.json', '.geojson'].includes(extname(path).toLowerCase()), 'SHP 또는 GeoJSON 파일을 선택해 주세요.');
  const canonical = await realpath(path);
  const paths = sourcePaths(canonical);
  const before = await signatures(paths);
  const originalCRS = extname(canonical).toLowerCase() === '.shp' ? (await readFile(paths[2], 'utf8')).trim() : (await geojson(canonical)).crs;
  converter(originalCRS);
  const record = { id: `terrain-${randomUUID()}`, title: title(canonical), path: canonical, originalCRS, bundled, sourceSha256: await sha256(paths), signatures: before };
  check(JSON.stringify(before) === JSON.stringify(await signatures(paths)), CHANGED);
  const source = await openSource(record);
  try { const first = await source.read(); check(!first.done); if (!source.normalized) normalized(first.value, converter(originalCRS)); }
  finally { await source.cancel(); }
  check(JSON.stringify(before) === JSON.stringify(await signatures(paths)), CHANGED);
  return record;
}

export async function createTerrainData({ dataDir, selectFile, bundledPath } = {}) {
  check(typeof dataDir === 'string' && isAbsolute(dataDir));
  const registryPath = join(dataDir, 'terrain-data.json');
  let registered = [];
  try {
    check((await stat(registryPath)).size <= 128 * 1024);
    const stored = JSON.parse(await readFile(registryPath, 'utf8'));
    check(stored?.version === 1 && Array.isArray(stored.datasets) && stored.datasets.length <= 20);
    for (const row of stored.datasets) {
      check(row && /^terrain-[a-f0-9-]+$/.test(row.id) && typeof row.path === 'string' && isAbsolute(row.path) && ['.shp', '.json', '.geojson'].includes(extname(row.path).toLowerCase()) && typeof row.title === 'string' && row.title === title(row.path) && typeof row.originalCRS === 'string' && row.originalCRS.length <= 4096 && /^[a-f0-9]{64}$/.test(row.sourceSha256) && Array.isArray(row.signatures) && row.signatures.length === sourcePaths(row.path).length && row.bundled === false);
      check(row.sourceKind === undefined || row.sourceKind === 'public-download');
      if (row.sourceKind === 'public-download') { downloadUrl(row.sourceUrl); downloadTime(row.downloadedAt); }
    }
    registered = stored.datasets;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('지형 자료 등록 정보를 읽을 수 없습니다.'); }
  const bundled = bundledPath ? await inspect(bundledPath, true) : null;
  let registration = Promise.resolve();
  function register(record, signal) {
    const pending = registration.then(async () => {
      signal?.throwIfAborted();
      const previous = registered.find(row => row.path === record.path);
      if (previous?.sourceSha256 === record.sourceSha256 && JSON.stringify(previous.signatures) === JSON.stringify(record.signatures) && (record.sourceKind === undefined || (previous.sourceKind === record.sourceKind && previous.sourceUrl === record.sourceUrl && previous.downloadedAt === record.downloadedAt))) return publicRecord(previous);
      check(previous || registered.length < 20, '지형 자료는 최대 20개까지 등록할 수 있습니다.');
      const next = [...registered.filter(row => row.path !== record.path), record];
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temp = join(dataDir, `terrain-data-${randomUUID()}.tmp`);
      try {
        signal?.throwIfAborted();
        await writeFile(temp, JSON.stringify({ version: 1, datasets: next }), { flag: 'wx', mode: 0o600 });
        signal?.throwIfAborted();
        await rename(temp, registryPath);
        registered = next;
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return publicRecord(record);
    });
    registration = pending.catch(() => {}); // A failed commit must not block later registrations.
    return pending;
  }
  return {
    async list() { return [...(bundled ? [bundled] : []), ...registered].map(publicRecord); },
    async importFile(trustedPath) {
      if (trustedPath === undefined) check(typeof selectFile === 'function', '이 실행 환경에는 지형 파일 선택 창이 없습니다.');
      const path = trustedPath ?? await selectFile();
      if (!path) return null;
      let record;
      try { record = await inspect(path); }
      catch (error) { if (/SHP|GeoJSON|좌표|표고/.test(error.message)) throw error; throw new Error(INVALID); }
      return register(record);
    },
    async registerDownload(metadata, options = {}) {
      try {
        check(options && Object.keys(options).every(key => key === 'signal') && (options.signal === undefined || options.signal instanceof AbortSignal));
        const { signal } = options;
        signal?.throwIfAborted();
        check(metadata && typeof metadata === 'object' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(metadata.id));
        check(typeof metadata.name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}$/u.test(metadata.name) && ['.json', '.geojson'].includes(extname(metadata.name).toLowerCase()));
        check(Number.isInteger(metadata.bytes) && metadata.bytes > 0 && metadata.bytes <= MAX_JSON && /^[a-f0-9]{64}$/.test(metadata.sha256));
        const sourceUrl = downloadUrl(metadata.url), downloadedAt = downloadTime(metadata.retrievedAt);
        const folder = join(dataDir, 'downloads'), expected = join(folder, `${metadata.id}-${metadata.name}`);
        check(metadata.path === expected);
        check((await lstat(folder)).isDirectory());
        const info = await lstat(expected);
        check(info.isFile() && !info.isSymbolicLink() && info.size === metadata.bytes);
        check(await realpath(folder) === join(await realpath(dataDir), 'downloads') && await realpath(expected) === join(await realpath(folder), basename(expected)));
        const record = await inspect(expected);
        signal?.throwIfAborted();
        check(record.path === join(await realpath(folder), basename(expected)) && (await lstat(expected)).isFile());
        check(record.sourceSha256 === metadata.sha256 && record.signatures[0].size === metadata.bytes);
        return await register({ ...record, sourceKind: 'public-download', sourceUrl, downloadedAt }, signal);
      } catch { throw new Error(options?.signal?.aborted ? '지형 자료 등록이 취소되었습니다.' : DOWNLOAD_INVALID); }
    },
    async query(input = {}) {
      check(input && typeof input === 'object' && Object.keys(input).every(key => ['bbox', 'datasetId', 'maxFeatures'].includes(key)));
      const bbox = checkBbox(input.bbox), maxFeatures = input.maxFeatures ?? 100;
      check(Number.isInteger(maxFeatures) && maxFeatures >= 1 && maxFeatures <= 100);
      const available = [...(bundled ? [bundled] : []), ...registered];
      check(available.length > 0, '먼저 지형 원본 파일을 등록해 주세요.');
      check(input.datasetId !== undefined || available.length === 1, '조회할 지형 자료의 datasetId를 선택해 주세요.');
      const record = input.datasetId === undefined ? available[0] : available.find(row => row.id === input.datasetId);
      check(record, '등록된 지형 자료를 선택해 주세요.');
      try { check(JSON.stringify(await signatures(sourcePaths(record.path))) === JSON.stringify(record.signatures), CHANGED); }
      catch { throw new Error(CHANGED); }
      const transform = converter(record.originalCRS), features = [], envelope = sourceEnvelope(transform, bbox);
      let source;
      try { source = await openSource(record); } catch { throw new Error(INVALID); }
      let possiblyTruncated = false, vertices = 0, scanned = 0;
      const deadline = Date.now() + 15000;
      try {
        while (true) {
          if (Date.now() > deadline || scanned >= 250000) { possiblyTruncated = true; break; }
          const item = await source.read();
          if (item.done) break;
          scanned++;
          if (!item.value?.geometry) continue;
          if (!source.normalized && !overlaps(item.value, envelope)) continue;
          const hit = source.normalized ? clipped(item.value, bbox) : normalized(item.value, transform, bbox);
          if (!hit) continue;
          const coords = hit.geometry.coordinates;
          const count = hit.geometry.type === 'Point' ? 1 : hit.geometry.type === 'LineString' ? coords.length : coords.reduce((sum, line) => sum + line.length, 0);
          if (features.length >= maxFeatures || vertices + count > 20000) { possiblyTruncated = true; break; }
          vertices += count;
          features.push(hit);
        }
      } catch { throw new Error(INVALID); }
      finally { await source.cancel(); }
      try { check(JSON.stringify(await signatures(sourcePaths(record.path))) === JSON.stringify(record.signatures), CHANGED); }
      catch { throw new Error(CHANGED); }
      check(features.length > 0, possiblyTruncated ? '조회 한도 내에 해당 영역 지형 자료가 없습니다. 다른 원본을 선택하거나 범위를 확인해 주세요.' : '해당 영역에 등록된 지형 자료가 없습니다.');
      return { type: 'FeatureCollection', crs: 'EPSG:4326', bbox, features, count: features.length, possiblyTruncated, sourceUrl: record.sourceKind === 'public-download' ? record.sourceUrl : SOURCE_URL, ...(record.downloadedAt ? { downloadedAt: record.downloadedAt } : {}), originalCRS: record.originalCRS, verticalDatum: 'unknown', sourceSha256: record.sourceSha256, sourceKind: publicRecord(record).sourceKind, sourceLabel: publicRecord(record).sourceLabel, datasetId: record.id, retrievedAt: new Date().toISOString(), untrusted: true };
    },
  };
}
