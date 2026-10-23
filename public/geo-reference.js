import { mmPerUnit } from './units.js';

export const GEO_LAYER = 'SITECAD_GEOREF';
export const OUTER_LAYER = 'VWORLD_PARCELS';
export const HOLE_LAYER = 'VWORLD_HOLES';
export const METADATA_PREFIX = 'SITECAD_GEOREF_V1:';
export const PUBLIC_TERRAIN_LABEL = '공개 다운로드 원본(원출처·표고 기준 미검증)';
export const PROJ_DEFINITION = '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
export const ANCHOR_FIELDS = ['version', 'sourceCRS', 'targetCRS', 'originLonLat', 'originProjectedM', 'insertionMm', 'units', 'mmPerUnit', 'metresToDrawingUnits', 'axis', 'modelScale', 'projDefinition', 'projectionLibrary'];
const FIELDS = ['version', 'sourceCRS', 'targetCRS', 'originLonLat', 'originProjectedM', 'insertionMm', 'units', 'mmPerUnit', 'metresToDrawingUnits', 'axis', 'modelScale', 'projDefinition', 'projectionLibrary', 'sourceId', 'url', 'retrievedAt', 'geometrySha256', 'featureCount', 'ringCount', 'netAreaM2', 'possiblyTruncated'];
const fail = () => { throw new Error('도면의 공간 기준 정보가 손상되었거나 지원 범위 밖입니다.'); };
const pair = (value, bound) => Array.isArray(value) && value.length === 2 && value.every(number => Number.isFinite(number) && Math.abs(number) <= bound);

function checkedSourceUrl(value, terrain) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) fail();
  if (terrain?.sourceKind === 'public-download') {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /(^|\.)(localhost|local|internal|home|lan|invalid|test)$/.test(host) ||
        [...url.searchParams.keys()].some(key => /key|token|secret|auth|credential|signature|password|session|^sig$/i.test(key)) ||
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(decodeURIComponent(url.pathname + url.search))) fail();
  } else if (url.hostname !== 'www.vworld.kr' || !(url.pathname.startsWith('/dev/') || (terrain && url.pathname === '/dtmk/dtmk_ntads_s002.do')) ||
      [...url.searchParams.keys()].some(key => /key|token|secret|authorization/i.test(key))) fail();
}

export function parseGeoReference(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'string') {
      if (!value.startsWith(METADATA_PREFIX)) return null;
      if (new TextEncoder().encode(value).byteLength >= 16_384) fail();
      value = JSON.parse(value.slice(METADATA_PREFIX.length));
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const terrain = value.kind === 'terrain';
    const fields = terrain ? [...FIELDS, 'kind', 'terrain'] : FIELDS;
    if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail();
    if (new TextEncoder().encode(METADATA_PREFIX + JSON.stringify(value)).byteLength >= 16_384) fail();
    const scale = mmPerUnit(value.units);
    if (value.version !== 1 || value.sourceCRS !== 'EPSG:4326' || value.targetCRS !== 'EPSG:5179' || value.axis !== 'E,N' || value.modelScale !== 1 ||
        value.projDefinition !== PROJ_DEFINITION || value.projectionLibrary !== 'proj4@2.21.0' || !Number.isInteger(value.units) || value.mmPerUnit !== scale || value.metresToDrawingUnits !== 1000 / scale) fail();
    if (!pair(value.originLonLat, 180) || value.originLonLat[0] < 124 || value.originLonLat[0] > 132 || value.originLonLat[1] < 32 || value.originLonLat[1] > 39.5 ||
        !pair(value.originProjectedM, 10_000_000) || !pair(value.insertionMm, 100_000_000)) fail();
    if (!Number.isInteger(value.featureCount) || value.featureCount < 1 || value.featureCount > 100 || typeof value.possiblyTruncated !== 'boolean') fail();
    if (terrain) {
      const info = value.terrain;
      const downloaded = info?.sourceKind === 'public-download';
      const keys = ['sourceCRS', 'verticalDatum', 'sourceSha256', 'sourceKind', 'contourCount', 'spotCount', 'minElevationM', 'maxElevationM', ...(downloaded ? ['sourceLabel', 'downloadedAt'] : [])];
      if (!info || typeof info !== 'object' || Array.isArray(info) || Object.keys(info).length !== keys.length || keys.some(key => !Object.hasOwn(info, key)) ||
          value.ringCount !== 0 || value.netAreaM2 !== null || typeof info.sourceCRS !== 'string' || !info.sourceCRS.trim() || info.sourceCRS.length > 8192 ||
          typeof info.verticalDatum !== 'string' || !info.verticalDatum.trim() || info.verticalDatum.length > 120 || /[\u0000-\u001f\u007f]/.test(info.sourceCRS + info.verticalDatum) ||
          !/^[a-f\d]{64}$/.test(info.sourceSha256) || !['local-file', 'bundled-vworld-contours', 'public-download'].includes(info.sourceKind) || ![info.contourCount, info.spotCount].every(count => Number.isInteger(count) && count >= 0 && count <= 500) ||
          info.contourCount + info.spotCount < value.featureCount || info.contourCount + info.spotCount > 500 ||
          ![info.minElevationM, info.maxElevationM].every(height => Number.isFinite(height) && height >= -500 && height <= 9000) || info.minElevationM > info.maxElevationM) fail();
      if (downloaded && (info.sourceLabel !== PUBLIC_TERRAIN_LABEL || info.verticalDatum !== 'unknown' || typeof info.downloadedAt !== 'string' || info.downloadedAt.length > 40 || !Number.isFinite(Date.parse(info.downloadedAt)))) fail();
    } else if (!Number.isInteger(value.ringCount) || value.ringCount < value.featureCount || value.ringCount > 200 || !Number.isFinite(value.netAreaM2) || value.netAreaM2 <= 0 || value.netAreaM2 > 40_000_000_000) fail();
    if (typeof value.sourceId !== 'string' || !/^[a-z\d_-]{1,80}$/i.test(value.sourceId) || typeof value.geometrySha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.geometrySha256) ||
        typeof value.retrievedAt !== 'string' || value.retrievedAt.length > 40 || !Number.isFinite(Date.parse(value.retrievedAt)) || typeof value.url !== 'string' || value.url.length > 2048) fail();
    checkedSourceUrl(value.url, terrain ? value.terrain : null);
    return { ...value, originLonLat: [...value.originLonLat], originProjectedM: [...value.originProjectedM], insertionMm: [...value.insertionMm], ...(terrain ? { terrain: { ...value.terrain } } : {}) };
  } catch { return fail(); }
}

export function metadataText(metadata) {
  const checked = parseGeoReference(metadata);
  if (!checked) fail();
  return METADATA_PREFIX + JSON.stringify(checked);
}
