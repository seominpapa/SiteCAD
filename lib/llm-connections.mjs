import { isAbsolute } from 'node:path';
import { createClaudeCodeAuth, CLAUDE_CODE_NOTICE } from './claude-code-auth.mjs';

const definitions = Object.freeze([
  { id: 'openai-oauth', label: 'OpenAI · ChatGPT OAuth', provider: 'openai', method: 'oauth' },
  { id: 'openai-api', label: 'OpenAI · API 키', provider: 'openai', method: 'api' },
  { id: 'anthropic-api', label: 'Claude · Anthropic API 키', provider: 'anthropic', method: 'api' },
  { id: 'anthropic-oauth', label: 'Claude · OAuth(구독)', provider: 'anthropic', method: 'oauth' },
]);
const invalid = () => Error('LLM 연결 종류와 입력 형식을 확인해 주세요.');
const storageError = () => Error('LLM 인증정보 보안 저장소를 확인해 주세요.');
const credentialError = () => Error('LLM 인증정보가 없습니다. 설정에서 로그인하거나 API 키를 등록해 주세요.');
function exact(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
}
function connection(input, allowed = ['id']) {
  exact(input, allowed);
  const entry = definitions.find(item => item.id === input.id);
  if (!entry) throw invalid();
  return entry;
}
function keyInput(input) {
  const entry = connection(input, ['id', 'apiKey', 'workspaceId']);
  if (entry.method !== 'api' || typeof input.apiKey !== 'string' || !/^[A-Za-z0-9._-]{16,8192}$/.test(input.apiKey)) throw invalid();
  if (input.workspaceId !== undefined && (entry.provider !== 'anthropic' || typeof input.workspaceId !== 'string' || !/^wrkspc_[A-Za-z0-9_-]{1,120}$/.test(input.workspaceId))) throw invalid();
  return { apiKey: input.apiKey, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
}
function checkedRecord(value) {
  if (value === null || value === undefined) return { version: 1, active: 'openai-oauth', keys: {}, anthropicOAuth: false };
  exact(value, ['version', 'active', 'keys', 'anthropicOAuth']);
  if (value.version !== 1 || !definitions.some(item => item.id === value.active) || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys) || typeof value.anthropicOAuth !== 'boolean') throw invalid();
  const entries = Object.entries(value.keys);
  if (entries.length > 2) throw invalid();
  return { version: 1, active: value.active, keys: Object.fromEntries(entries.map(([id, item]) => [id, keyInput({ ...item, id })])), anthropicOAuth: value.anthropicOAuth };
}
async function readModels(response) {
  if (!response.ok || !response.body) throw Error('models');
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw Error('models'); }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(value?.data) || !value.data.length || !value.data.every(item => typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 256)) throw Error('models');
  return value.data.length;
}

/** API keys use the encrypted store; official Claude Code owns subscription authentication. */
export function createLlmConnections({ store, oauth, dataDir, fetchImpl = fetch, executeImpl, claudePath, claudeCodeAuth } = {}) {
  if (!isAbsolute(dataDir ?? '') || !oauth?.status || !oauth?.getAccessToken) throw invalid();
  const claude = claudeCodeAuth ?? createClaudeCodeAuth({ dataDir, claudePath, ...(executeImpl ? { executeImpl } : {}) });
  let recordPromise, checks = new Map(), writeQueue = Promise.resolve();
  const read = () => {
    recordPromise ??= (async () => {
      try { return checkedRecord(await store?.read?.()); } catch { throw storageError(); }
    })();
    return recordPromise;
  };
  const update = transform => {
    const task = writeQueue.then(async () => {
      const next = transform(await read());
      if (!store?.write) throw storageError();
      try { await store.write(next); } catch { throw storageError(); }
      recordPromise = Promise.resolve(next);
    });
    writeQueue = task.catch(() => {});
    return task;
  };
  const oauthStatus = async () => {
    try { const value = await oauth.status(); return { loggedIn: value?.loggedIn === true && value.sharing !== false, pending: value?.pending === true }; }
    catch { return { loggedIn: false, pending: false }; }
  };
  async function status() {
    const [record, account, code] = await Promise.all([read(), oauthStatus(), claude.status()]);
    const connections = definitions.map(entry => {
      const configured = entry.id === 'openai-oauth' ? account.loggedIn : entry.id === 'anthropic-oauth' ? code.loggedIn === true : Boolean(record.keys[entry.id]);
      return { ...entry, configured, connected: configured,
        notice: entry.id === 'anthropic-oauth' ? CLAUDE_CODE_NOTICE : entry.method === 'api' ? 'API 사용량은 제공업체에서 별도 과금됩니다. 연결 확인은 모델 목록만 조회하며 모델 실행 권한은 실제 요청에서 확인됩니다.' : '사용자 본인의 ChatGPT 계정으로 연결합니다.',
        ...(checks.has(entry.id) ? { lastCheck: { ...checks.get(entry.id) } } : {}),
        ...(entry.id === 'anthropic-oauth' && code.error ? { error: code.error } : {}) };
    });
    const selected = connections.find(entry => entry.id === record.active);
    return { active: record.active, connected: selected.connected, label: selected.label, pending: code.pending === true || account.pending,
      connections, anthropicOAuth: { ...code } };
  }
  const readCredentials = async id => {
    const record = await read(), entry = definitions.find(item => item.id === id);
    if (!entry) throw invalid();
    const base = { id, provider: entry.provider, method: entry.method };
    if (entry.method === 'api') {
      if (!record.keys[id]) throw credentialError();
      return { ...base, ...record.keys[id] };
    }
    if (id === 'anthropic-oauth') throw Error('Claude OAuth 인증은 공식 Claude Code가 관리합니다. 앱에서 구독 토큰을 읽지 않습니다.');
    if (!(await oauthStatus()).loggedIn) throw credentialError();
    try { return { ...base, accessToken: await oauth.getAccessToken() }; } catch { throw credentialError(); }
  };
  return {
    status, activeId: async () => (await read()).active, credentials: async () => readCredentials((await read()).active),
    cancel: () => claude.cancel(), claudeCodeRuntimeOptions: () => claude.runtimeOptions(),
    async save(input) {
      const value = keyInput(input);
      await update(record => ({ ...record, keys: { ...record.keys, [input.id]: value } }));
      checks = new Map([...checks].filter(([id]) => id !== input.id));
      return status();
    },
    async select(input) {
      connection(input);
      if (!(await status()).connections.find(entry => entry.id === input.id)?.connected) throw credentialError();
      await update(record => ({ ...record, active: input.id }));
      return status();
    },
    async remove(input) {
      const entry = connection(input); await claude.cancel();
      if (entry.id === 'openai-oauth') {
        try { await oauth.logout(); } catch { throw Error('ChatGPT 로그아웃을 완료하지 못했습니다.'); }
      }
      if (entry.id === 'anthropic-oauth') await claude.logout();
      await update(record => ({ ...record, active: record.active === input.id ? 'openai-oauth' : record.active,
        keys: Object.fromEntries(Object.entries(record.keys).filter(([id]) => id !== input.id)) }));
      checks = new Map([...checks].filter(([id]) => id !== input.id));
      return status();
    },
    async test(input) {
      const entry = connection(input); let result;
      try {
        if (entry.id === 'anthropic-oauth') {
          const code = await claude.status();
          result = { ok: code.loggedIn === true, message: code.loggedIn ? '공식 Claude Code 구독 로그인을 확인했습니다. 실제 모델 실행·사용 한도는 요청 시 확인됩니다.' : '설정에서 공식 Claude Code OAuth 로그인을 완료해 주세요.' };
        } else {
          const credentials = await readCredentials(entry.id);
          const response = await fetchImpl(`https://api.${entry.provider === 'openai' ? 'openai' : 'anthropic'}.com/v1/models`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { ...(entry.id === 'anthropic-api' ? { 'x-api-key': credentials.apiKey } : { Authorization: `Bearer ${credentials.apiKey ?? credentials.accessToken}` }),
              ...(entry.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
              ...(credentials.workspaceId ? { 'anthropic-workspace-id': credentials.workspaceId } : {}) },
          });
          if (!response.ok) {
            result = { ok: false, status: response.status, message: response.status === 401 || response.status === 403 ? '인증정보 또는 API 사용 권한을 확인해 주세요.' : response.status === 429 ? '요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.' : 'LLM 서비스 연결을 확인하지 못했습니다.' };
            await response.body?.cancel().catch(() => {});
          } else result = { ok: true, modelCount: await readModels(response), message: '모델 목록 연결을 확인했습니다. 실제 모델 실행·과금·권한은 별도입니다.' };
        }
      } catch { result = { ok: false, message: 'LLM 연결을 확인하지 못했습니다. 인증정보·공식 CLI 로그인·네트워크를 확인해 주세요.' }; }
      const check = { ...result, checkedAt: new Date().toISOString() };
      checks = new Map([...checks, [entry.id, check]]);
      return { ...check };
    },
    async login(input) {
      const entry = connection(input);
      if (entry.method !== 'oauth') throw invalid();
      if (entry.id === 'anthropic-oauth') {
        const result = await claude.login();
        return { ...await status(), ...result };
      }
      try { await oauth.login(); return status(); } catch { throw Error('ChatGPT 로그인을 시작하지 못했습니다. 다시 시도해 주세요.'); }
    },
  };
}
