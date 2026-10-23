import proj4 from 'proj4';

const LAYER_URL = 'https://gis.gjcity.go.kr/arcgis/rest/services/GJUIS/LifeMapDynamic/MapServer/34';
const KOREA_2000_CENTRAL_2010 = '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs';
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function radius(value) {
  if (!Number.isInteger(value) || value < 25 || value > 250) throw Error('조회 반경은 25~250m 사이의 정수여야 합니다.');
  return value;
}

function koreanPoint(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 124 && x <= 132 && y >= 32 && y <= 39.5;
}

function point(geocoded) {
  const { x, y } = geocoded?.point ?? {};
  if (geocoded?.crs !== 'EPSG:4326' || !koreanPoint(x, y)) throw Error('대한민국 EPSG:4326 주소 좌표를 확인해 주세요.');
  return [x, y];
}

function checkedArea(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !koreanPoint(bbox[0], bbox[1]) || !koreanPoint(bbox[2], bbox[3]) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw Error('대한민국 경위도 조회 영역을 확인해 주세요.');
  const width = (bbox[2] - bbox[0]) * 111320 * Math.cos((bbox[1] + bbox[3]) * Math.PI / 360);
  const height = (bbox[3] - bbox[1]) * 111320;
  if (width * height > 1e6 || width > 2000 || height > 2000) throw Error('공개 지형 조회 영역은 1km², 각 변 2km 이하여야 합니다.');
  return [...bbox];
}

export function siteRequest(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => !['address', 'radius_m'].includes(key)) || typeof input.address !== 'string' || CONTROLS.test(input.address) || !input.address.trim() || input.address.trim().length > 300) throw Error('300자 이하의 주소와 조회 범위만 입력해 주세요.');
  return { address: input.address.trim(), radius_m: radius(input.radius_m === undefined ? 100 : input.radius_m) };
}

export function siteArea(geocoded, radius_m = 100) {
  const [x, y] = point(geocoded), metres = radius(radius_m);
  // shortcut: small Korean search envelopes use a local degree approximation; geometry insertion uses the existing EPSG projection.
  const dx = metres / (111320 * Math.cos(y * Math.PI / 180)), dy = metres / 111320;
  return checkedArea([x - dx, y - dy, x + dx, y + dy]);
}

export function publicTerrainSource(geocoded, bbox) {
  const [longitude, latitude] = point(geocoded), area = checkedArea(bbox);
  if (longitude < area[0] || longitude > area[2] || latitude < area[1] || latitude > area[3]) throw Error('주소 좌표를 포함한 조회 영역을 사용해 주세요.');
  const [x, y] = proj4('EPSG:4326', KOREA_2000_CENTRAL_2010, [longitude, latitude]);
  if (typeof geocoded.address !== 'string' || !/^(경기도|경기)\s+광주시(?:\s|$)/.test(geocoded.address.trim()) || x < 211000 || x > 240700 || y < 516600 || y > 550700) return { supported: false, message: '이 주소에서 자동 조회할 공개 지형 제공처가 아직 등록되지 않았습니다. 현재 자동 제공처는 경기도 광주시 공개 등고선입니다.' };
  const url = new URL(`${LAYER_URL}/query`);
  url.search = new URLSearchParams({ f: 'geojson', geometry: area.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', where: '1=1', outFields: 'OBJECTID,ELE_ALT,CAA_CDE', returnGeometry: 'true', orderByFields: 'OBJECTID' }).toString();
  return { supported: true, providerId: 'gwangju-city-contours', url: url.href, fileName: 'gwangju-public-contours.geojson', sourceLabel: '광주시 공개 등고선(표고 단위·수직 기준면 미검증)', unitAssumption: 'm', verticalDatum: 'unknown', catalogUrl: LAYER_URL };
}
