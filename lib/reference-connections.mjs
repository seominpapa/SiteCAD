import { createVworldApi } from './vworld-api.mjs';

export const referenceCatalog = Object.freeze([
  { id: 'sitecad', name: 'SiteCAD 내부 MCP', kind: 'builtin', status: 'available', description: '도면 생성·수정·물량검토·DWG 저장' },
  { id: 'web', name: '웹검색·문서 조회', kind: 'builtin', status: 'available', description: '내장 검색과 HTML·PDF 원문 조회 · 추가 등록 불필요' },
  { id: 'standards', name: '국내 KDS·KCS', kind: 'source', status: 'available', description: '국가건설기준센터 우선 검색 · 실제 원문·개정일 확인 필요', url: 'https://www.kcsc.re.kr/' },
  { id: 'vworld', name: 'VWorld API', kind: 'api', status: 'key_required', description: '주소·필지 경계 조회와 좌표 변환·도면 삽입 · 개인 API 키 필요', url: 'https://www.vworld.kr/' },
  { id: 'terrain', name: '지형도·표고 삽입', kind: 'local_source', status: 'source_required', description: '경기도 광주시 주소로 공개 등고선 자동 조회·삽입·저장 · 다른 지역은 원본 등록', url: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30185' },
]);

const invalid = () => Error('VWorld API 키와 등록 도메인을 확인해 주세요.');
function checked(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['apiKey', 'domain'].includes(key)) || typeof input.apiKey !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(input.apiKey)) throw invalid();
  let domain;
  if (input.domain !== undefined && input.domain !== '') {
    if (typeof input.domain !== 'string' || input.domain.length > 500) throw invalid();
    try {
      const url = new URL(input.domain);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid();
      domain = url.origin;
    } catch { throw invalid(); }
  }
  return { apiKey: input.apiKey, ...(domain ? { domain } : {}) };
}

export function createReferenceConnections({ store, apiFactory = createVworldApi, now = () => new Date() } = {}) {
  let lastCheck;
  const readCredentials = async () => {
    if (!store) return null;
    try { const value = await store.read(); return value === null ? null : checked(value); }
    catch { throw Error('VWorld 인증정보 저장소를 확인해 주세요.'); }
  };
  const api = apiFactory({ readCredentials });
  const status = async () => {
    const credentials = await readCredentials();
    return { catalog: structuredClone(referenceCatalog), vworld: { configured: Boolean(credentials), ...(credentials?.domain ? { domain: credentials.domain } : {}), ...(lastCheck ? { lastCheck: structuredClone(lastCheck) } : {}) } };
  };
  return {
    api, status,
    async save(input) {
      const value = checked(input);
      if (!store?.write) throw Error('VWorld 인증정보를 암호화해서 저장할 수 없습니다.');
      try { await store.write(value); } catch { throw Error('VWorld 인증정보를 암호화해서 저장하지 못했습니다.'); }
      lastCheck = undefined;
      return status();
    },
    async remove() {
      try { await store?.remove(); } catch { throw Error('VWorld 인증정보를 삭제하지 못했습니다.'); }
      lastCheck = undefined;
      return status();
    },
    async test() {
      if (!(await readCredentials())) throw Error('먼저 VWorld API 키를 등록해 주세요.');
      try {
        const value = await api.geocode({ address: '서울특별시 중구 세종대로 110', type: 'ROAD' });
        lastCheck = { ok: true, checkedAt: now().toISOString(), message: '지정 주소의 좌표를 실제 조회했습니다.' };
        return { ...lastCheck, point: value.point, crs: value.crs };
      } catch {
        lastCheck = { ok: false, checkedAt: now().toISOString(), message: 'VWorld 조회에 실패했습니다. 키·서비스 권한·등록 도메인·네트워크를 확인해 주세요.' };
        return { ...lastCheck };
      }
    },
  };
}
