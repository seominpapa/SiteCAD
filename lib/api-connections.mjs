import { mkdir, lstat, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const fail = message => Object.assign(Error(message), { sitecadSafe: true });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(id) && !['vworld', 'kcsc', 'openai', 'anthropic', 'sitecad', 'constructor', 'prototype'].includes(id);
const metadataError = () => fail('API 등록 정보를 읽거나 저장하지 못했습니다. 기존 등록 파일을 확인해 주세요.');

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw fail('인증값 없는 공개 HTTPS 주소를 입력해 주세요.');
  let url;
  try { url = new URL(value); } catch { throw fail('공개 HTTPS 주소를 확인해 주세요.'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || isIP(host.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) throw fail('인증값 없는 공개 HTTPS 주소를 입력해 주세요.');
  return url;
}

// This records a reviewed service, not an executable API adapter or a fetched document.
export function checkedApiRegistration(value) {
  if (!exact(value, ['id', 'name', 'url', 'issuanceUrl']) || !validId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name)) throw fail('API 이름과 등록 입력을 확인해 주세요. 인증키는 설정에서만 입력할 수 있습니다.');
  const url = publicUrl(value.url), issuance = publicUrl(value.issuanceUrl);
  if (url.hostname.replace(/^www\./, '') !== issuance.hostname.replace(/^www\./, '')) throw fail('발급 안내 주소는 등록한 API와 같은 사이트여야 합니다. 공식 사이트에서 확인해 주세요.');
  return { id: value.id, name: value.name.trim(), url: url.href, issuanceUrl: issuance.href };
}

export function apiCredentialRequest(id) {
  const sources = { vworld: { name: 'VWorld', issuanceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do' }, kcsc: { name: '국가건설기준센터 KCSC', issuanceUrl: 'https://kcsc.re.kr/support/api' } };
  if (!Object.hasOwn(sources, id)) throw fail('지원하는 API 안내 항목을 확인해 주세요.');
  const { name, issuanceUrl } = sources[id];
  return { status: 'key_required', settingsTarget: 'api', apiId: id, issuanceUrl, message: `${name} 공식 사이트(${issuanceUrl})에서 API 이용 신청·키 발급을 확인한 뒤 설정 → API의 해당 항목에 입력해 주세요. 채팅에는 키를 보내지 마세요.` };
}

export async function createApiConnections({ dataDir, store }) {
  if (!isAbsolute(dataDir ?? '')) throw metadataError();
  const path = join(dataDir, 'api-connections.json');
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw metadataError();
    await chmod(dataDir, 0o700);
  } catch { throw metadataError(); }
  let queue = Promise.resolve();
  const serialized = callback => { const result = queue.then(callback); queue = result.catch(() => {}); return result; };

  async function metadata() {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw metadataError();
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!exact(value, ['version', 'apis']) || value.version !== 1 || !Array.isArray(value.apis) || value.apis.length > 100) throw metadataError();
      const ids = new Set();
      return value.apis.map(item => {
        if (!exact(item, ['id', 'name', 'url', 'issuanceUrl', 'createdAt', 'updatedAt']) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt)) || ids.has(item.id)) throw metadataError();
        const checked = checkedApiRegistration({ id: item.id, name: item.name, url: item.url, issuanceUrl: item.issuanceUrl });
        ids.add(item.id);
        return { ...checked, createdAt: item.createdAt, updatedAt: item.updatedAt };
      });
    } catch (error) { if (error.code === 'ENOENT') return []; throw metadataError(); }
  }
  async function persist(apis) {
    const temporary = join(dataDir, `.api-connections-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, apis }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch { throw metadataError(); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw metadataError(); }); }
  }
  async function credentials() {
    try {
      const value = await store?.read();
      if (value == null) return {};
      if (!exact(value, ['version', 'keys']) || value.version !== 1 || !plain(value.keys) || Object.entries(value.keys).some(([id, key]) => !validId(id) || typeof key !== 'string' || !/^[\x21-\x7e]{8,8192}$/.test(key))) throw Error();
      return { ...value.keys };
    } catch { throw fail('API 인증정보를 읽지 못했습니다. 비공개 저장소를 확인해 주세요.'); }
  }
  async function saveCredentials(keys) {
    if (!store?.write) throw fail('API 인증정보를 저장할 비공개 저장소가 없습니다.');
    try { await store.write({ version: 1, keys }); }
    catch { throw fail('API 인증정보를 저장하지 못했습니다. 다시 시도해 주세요.'); }
  }
  const publicItem = (item, keys) => {
    const configured = typeof keys[item.id] === 'string';
    return { ...item, configured, status: configured ? 'key_saved' : 'key_required', keyRequired: true, adapterReady: false,
      message: configured ? '키를 저장했습니다. 이 API의 실행 연결은 아직 구성되지 않았습니다.' : '발급 안내 페이지에서 키를 발급받아 설정 → API의 해당 항목에 입력해 주세요. 이 API의 실행 연결은 아직 구성되지 않았습니다.' };
  };
  const knownItem = (apis, id) => {
    if (!validId(id)) throw fail('API 항목을 확인해 주세요.');
    const item = apis.find(api => api.id === id);
    if (!item) throw fail('먼저 채팅에서 API를 등록해 주세요.');
    return item;
  };
  await metadata();
  return {
    list: () => serialized(async () => { const apis = await metadata(), keys = await credentials(); return { apis: apis.map(item => publicItem(item, keys)) }; }),
    register: value => serialized(async () => {
      const proposal = checkedApiRegistration(value), apis = await metadata();
      const previous = apis.find(item => item.id === proposal.id);
      if (previous && ['name', 'url', 'issuanceUrl'].some(key => previous[key] !== proposal[key])) throw fail('이미 등록된 API 이름입니다. 기존 항목을 설정에서 확인해 주세요.');
      if (!previous && apis.length >= 100) throw fail('API 등록 항목은 100개까지 지원합니다.');
      const keys = await credentials(), timestamp = new Date().toISOString();
      const item = previous ?? { ...proposal, createdAt: timestamp, updatedAt: timestamp };
      if (!previous) await persist([...apis, item]);
      const api = publicItem(item, keys);
      return { api, status: api.status, settingsTarget: 'api', apiId: api.id, issuanceUrl: api.issuanceUrl, message: api.message };
    }),
    save: value => serialized(async () => {
      if (!exact(value, ['id', 'apiKey']) || typeof value.apiKey !== 'string' || !/^[\x21-\x7e]{8,8192}$/.test(value.apiKey)) throw fail('API 키를 확인해 주세요. 공백 없이 설정에서 입력해 주세요.');
      const item = knownItem(await metadata(), value.id), keys = { ...await credentials(), [value.id]: value.apiKey };
      await saveCredentials(keys);
      return { api: publicItem(item, keys) };
    }),
    remove: value => serialized(async () => {
      if (!exact(value, ['id'])) throw fail('API 삭제 요청을 확인해 주세요.');
      const apis = await metadata(); knownItem(apis, value.id);
      const keys = await credentials();
      if (Object.hasOwn(keys, value.id)) await saveCredentials(Object.fromEntries(Object.entries(keys).filter(([id]) => id !== value.id)));
      await persist(apis.filter(item => item.id !== value.id));
      return { removed: true, id: value.id };
    })
  };
}
