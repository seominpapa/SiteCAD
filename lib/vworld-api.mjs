import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const CRS = 'EPSG:4326';
const GEOCODE_SOURCE = 'https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do';
const PARCEL_SOURCE = 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral';
const CONFIG_ERROR = 'VWorld API 키와 등록 도메인 설정을 채팅의 /api vworld 전용 입력 카드에서 확인해 주세요.';
const RESPONSE_ERROR = 'VWorld 응답 형식이나 좌표가 올바르지 않습니다.';
const REQUEST_ERROR = 'VWorld 조회에 실패했습니다. API 설정·호출 한도·네트워크를 확인해 주세요.';

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const first = parseInt(address.split(':')[0], 16);
  const second = parseInt(address.split(':')[1] || '0', 16);
  return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error(REQUEST_ERROR));
    else signal.addEventListener('abort', () => reject(new Error(REQUEST_ERROR)), { once: true });
  });
}

async function requestJson(url, { signal }) {
  const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), aborted(signal)]);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error(REQUEST_ERROR);
  const { address, family } = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      agent: false, signal, rejectUnauthorized: true, servername: url.hostname, maxHeaderSize: 16 * 1024,
      headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'SiteCAD/0.4' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, response => resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])), body: response }));
    req.once('error', reject);
    req.end();
  });
}

async function discard(response) {
  if (typeof response.body?.destroy === 'function') response.body.destroy();
  else await response.body?.cancel?.().catch(() => {});
}

async function responseJson(response) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const encoding = response.headers.get('content-encoding');
  if (response.status !== 200 || type !== 'application/json' || (encoding && encoding !== 'identity') || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await discard(response);
    throw new Error(REQUEST_ERROR);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) { await discard(response); throw new Error(REQUEST_ERROR); }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function validPoint(x, y) {
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 124 && x <= 132 && y >= 32 && y <= 39.5;
}

function checkedBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !validPoint(bbox[0], bbox[1]) || !validPoint(bbox[2], bbox[3]) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('대한민국 경위도 범위의 올바른 bbox를 입력해 주세요.');
  const width = (bbox[2] - bbox[0]) * 111_320 * Math.cos((bbox[1] + bbox[3]) * Math.PI / 360);
  const height = (bbox[3] - bbox[1]) * 111_320;
  if (width * height > 1_000_000 || width > 2000 || height > 2000) throw new Error('필지 조회 영역은 1km² 이하이고 각 변이 2km 이하여야 합니다.');
  return [...bbox];
}

function safeText(value, key, max = 240) {
  if (typeof value !== 'string') return '';
  if (value.includes(key)) throw new Error(RESPONSE_ERROR);
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
}

function checkedGeometry(geometry, remaining) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error(RESPONSE_ERROR);
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || !polygons.length || polygons.length > 1000) throw new Error(RESPONSE_ERROR);
  let pointsRead = 0;
  const result = polygons.map(polygon => {
    if (!Array.isArray(polygon) || !polygon.length || polygon.length > 1000) throw new Error(RESPONSE_ERROR);
    return polygon.map(ring => {
      if (!Array.isArray(ring) || ring.length < 4 || pointsRead + ring.length > remaining) throw new Error(RESPONSE_ERROR);
      pointsRead += ring.length;
      const points = ring.map(point => {
        if (!Array.isArray(point) || point.length !== 2 || !validPoint(point[0], point[1])) throw new Error(RESPONSE_ERROR);
        return [...point];
      });
      if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw new Error(RESPONSE_ERROR);
      return points;
    });
  });
  return { geometry: { type: geometry.type, coordinates: geometry.type === 'Polygon' ? result[0] : result }, pointsRead };
}

function geographicCrs(value) {
  if (typeof value === 'string') return value.toUpperCase() === CRS;
  return value?.type === 'name' && ['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'].includes(value.properties?.name);
}

async function credentialsFrom(readCredentials) {
  try {
    const credentials = await readCredentials();
    if (!credentials || typeof credentials.apiKey !== 'string' || !/^[a-z\d_-]{4,256}$/i.test(credentials.apiKey)) throw new Error(CONFIG_ERROR);
    let domain;
    if (credentials.domain !== undefined && credentials.domain !== '') {
      if (typeof credentials.domain !== 'string' || credentials.domain.length > 2048) throw new Error(CONFIG_ERROR);
      const url = new URL(credentials.domain);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(CONFIG_ERROR);
      domain = url.href;
    }
    return { apiKey: credentials.apiKey, domain };
  } catch { throw new Error(CONFIG_ERROR); }
}

export function createVworldApi({ readCredentials, request = requestJson } = {}) {
  async function call(path, params) {
    const credentials = await credentialsFrom(readCredentials);
    const url = new URL(path, 'https://api.vworld.kr');
    url.search = new URLSearchParams({ ...params, key: credentials.apiKey, ...(credentials.domain ? { domain: credentials.domain } : {}) }).toString();
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await Promise.race([request(url, { signal, maxBytes: MAX_BYTES }), aborted(signal)]);
      const body = await Promise.race([responseJson(response), aborted(signal)]);
      if (!body?.response || !['OK', 'NOT_FOUND'].includes(body.response.status)) throw new Error(REQUEST_ERROR);
      return { response: body.response, key: credentials.apiKey };
    } catch { throw new Error(REQUEST_ERROR); }
  }

  return {
    async geocode({ address, type = 'ROAD' } = {}) {
      if (typeof address !== 'string' || !address.trim() || address.length > 300 || /[\u0000-\u001f\u007f]/.test(address) || !['ROAD', 'PARCEL'].includes(type)) throw new Error('300자 이하의 주소와 ROAD 또는 PARCEL 주소 유형을 입력해 주세요.');
      const { response, key } = await call('/req/address', { service: 'address', version: '2.0', request: 'getcoord', type, address: address.trim(), crs: CRS, format: 'json', errorformat: 'json', refine: 'true', simple: 'false' });
      if (response.status === 'NOT_FOUND') throw new Error('해당 주소의 좌표를 찾지 못했습니다.');
      const point = response.result?.point;
      const number = value => typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      const x = number(point?.x), y = number(point?.y);
      if (!geographicCrs(response.result?.crs) || !validPoint(x, y)) throw new Error(RESPONSE_ERROR);
      return { crs: CRS, point: { x, y }, address: safeText(response.refined?.text || address.trim(), key), type, sourceUrl: GEOCODE_SOURCE, retrievedAt: new Date().toISOString(), untrusted: true };
    },
    async parcels({ bbox: input, maxFeatures = 50 } = {}) {
      const bbox = checkedBbox(input);
      if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 100) throw new Error('필지 최대 개수는 1~100 사이의 정수여야 합니다.');
      const { response, key } = await call('/req/data', { service: 'data', version: '2.0', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN', format: 'json', errorformat: 'json', crs: CRS, geomFilter: `BOX(${bbox.join(',')})`, size: String(maxFeatures), page: '1', geometry: 'true', attribute: 'true', columns: 'pnu,addr' });
      const collection = response.status === 'NOT_FOUND' ? { type: 'FeatureCollection', features: [] } : response.result?.featureCollection;
      if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.features.length > maxFeatures || (collection.crs && !geographicCrs(collection.crs))) throw new Error(RESPONSE_ERROR);
      let pointsRead = 0;
      const features = collection.features.map(feature => {
        if (feature?.type !== 'Feature') throw new Error(RESPONSE_ERROR);
        const properties = feature.properties ?? {};
        const pnu = typeof properties.pnu === 'string' && /^\d{19}$/.test(properties.pnu) ? safeText(properties.pnu, key, 19) : '';
        const address = safeText(properties.addr, key);
        const checked = checkedGeometry(feature.geometry, 20_000 - pointsRead);
        pointsRead += checked.pointsRead;
        return { type: 'Feature', geometry: checked.geometry, properties: { ...(pnu ? { pnu } : {}), ...(address ? { address } : {}) } };
      });
      const total = Number(response.record?.total);
      return { type: 'FeatureCollection', crs: CRS, bbox, features, count: features.length, possiblyTruncated: features.length === maxFeatures || (Number.isSafeInteger(total) && total > features.length), sourceUrl: PARCEL_SOURCE, retrievedAt: new Date().toISOString(), untrusted: true };
    },
  };
}
