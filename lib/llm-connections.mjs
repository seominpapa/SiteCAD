import { execFile } from 'node:child_process';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const INSTALL_URL = 'https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart';
const CLI_NOTICE = 'Claude Console OAuth는 API 사용량으로 과금됩니다. Claude.ai 구독 토큰을 가져오지 않으며, 공식 Anthropic CLI가 전용 프로필의 인증을 관리합니다.';
const definitions = Object.freeze([
  { id: 'openai-oauth', label: 'OpenAI · ChatGPT OAuth', provider: 'openai', method: 'oauth' },
  { id: 'openai-api', label: 'OpenAI · API 키', provider: 'openai', method: 'api' },
  { id: 'anthropic-api', label: 'Claude · Anthropic API 키', provider: 'anthropic', method: 'api' },
  { id: 'anthropic-oauth', label: 'Claude · Console OAuth', provider: 'anthropic', method: 'oauth' },
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

/** Keys live only in the caller's encrypted store; official ant owns its isolated OAuth profile. */
export function createLlmConnections({ store, oauth, dataDir, fetchImpl = fetch, executeImpl = execute, antPath } = {}) {
  if (!isAbsolute(dataDir ?? '') || !oauth?.status || !oauth?.getAccessToken) throw invalid();
  let recordPromise; let writeQueue = Promise.resolve(); let commandPromise; let pending; let epoch = 0;
  let checks = new Map(); let cliError;
  const commandIdentities = new Map();
  const cliDirectory = join(dataDir, 'anthropic-cli');
  const read = () => {
    recordPromise ??= (async () => {
      try { return checkedRecord(await store?.read?.()); } catch { throw storageError(); }
    })();
    return recordPromise;
  };
  const update = transform => {
    const task = writeQueue.then(async () => {
      const next = transform(await read());
      if (!next) return;
      if (!store?.write) throw storageError();
      try { await store.write(next); } catch { throw storageError(); }
      recordPromise = Promise.resolve(next);
    });
    writeQueue = task.catch(() => {});
    return task;
  };
  const findCommand = async () => {
    if (commandPromise) return commandPromise;
    const task = (async () => {
      const probed = new Set();
      if (antPath === null) return null;
      const executable = process.platform === 'win32' ? 'ant.exe' : 'ant';
      const standard = process.platform === 'win32'
        ? [join(homedir(), '.local', 'bin', executable)]
        : [join(homedir(), '.local', 'bin', executable), join('/opt/homebrew/bin', executable), join('/usr/local/bin', executable), join('/usr/bin', executable)];
      const pathDirs = String(process.env.PATH ?? '').split(delimiter).filter(path => isAbsolute(path)).slice(0, 80);
      const candidates = antPath === undefined ? [...standard, ...pathDirs.map(path => join(path, executable))] : [antPath];
      for (const path of new Set(candidates)) {
        if (typeof path !== 'string' || !isAbsolute(path)) continue;
        try {
          const resolved = await realpath(path), info = await stat(resolved);
          if (!info.isFile() || probed.has(resolved)) continue;
          probed.add(resolved);
          await access(resolved, constants.X_OK);
          const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          const cached = commandIdentities.get(resolved);
          if (cached?.signature === signature) { if (cached.official) return resolved; continue; }
          const identity = await executeImpl(resolved, ['--help'], { env: cliEnv(resolved), shell: false, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
          const official = /CLI for (?:the )?(?:Claude Developer Platform|Anthropic API)/i.test(identity.stdout ?? '');
          commandIdentities.set(resolved, { signature, official });
          if (official) return resolved;
        } catch { /* The next fixed installation path may contain the official CLI. */ }
      }
      return null;
    })();
    commandPromise = task;
    try { return await task; } finally { if (commandPromise === task) commandPromise = undefined; }
  };
  const cliEnv = command => {
    const windows = process.platform === 'win32';
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    return { HOME: homedir(), LANG: 'en_US.UTF-8',
      PATH: windows ? [dirname(command), join(systemRoot, 'System32'), systemRoot].join(';') : `${dirname(command)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...(windows ? { SystemRoot: systemRoot, WINDIR: systemRoot, USERPROFILE: homedir(), APPDATA: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), LOCALAPPDATA: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), TEMP: process.env.TEMP || dataDir } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ANTHROPIC_CONFIG_DIR: cliDirectory, ANTHROPIC_DEFAULT_PROFILE: 'sitecad' };
  };
  const cli = async (args, { signal, timeout = 20000 } = {}) => {
    const command = await findCommand();
    if (!command) throw credentialError();
    await mkdir(cliDirectory, { recursive: true, mode: 0o700 });
    return executeImpl(command, args, { cwd: cliDirectory, env: cliEnv(command), shell: false, windowsHide: true, timeout, maxBuffer: 128 * 1024, ...(signal ? { signal } : {}) });
  };
  const oauthStatus = async () => {
    try { const status = await oauth.status(); return { loggedIn: status?.loggedIn === true && status.sharing !== false, pending: status?.pending === true }; }
    catch { return { loggedIn: false, pending: false }; }
  };
  async function status() {
    const [record, account, command] = await Promise.all([read(), oauthStatus(), findCommand()]);
    const connections = definitions.map(entry => {
      const configured = entry.id === 'openai-oauth' ? account.loggedIn : entry.id === 'anthropic-oauth' ? record.anthropicOAuth : Boolean(record.keys[entry.id]);
      return { ...entry, configured, connected: configured && (entry.id !== 'anthropic-oauth' || Boolean(command)),
        notice: entry.id === 'anthropic-oauth' ? CLI_NOTICE : entry.method === 'api' ? 'API 사용량은 제공업체에서 별도 과금됩니다. 연결 확인은 모델 목록만 조회하며 모델 실행 권한은 실제 요청에서 확인됩니다.' : '사용자 본인의 ChatGPT 계정으로 연결합니다.',
        ...(checks.has(entry.id) ? { lastCheck: { ...checks.get(entry.id) } } : {}),
        ...(entry.id === 'anthropic-oauth' && cliError ? { error: cliError } : {}) };
    });
    const selected = connections.find(entry => entry.id === record.active);
    return { active: record.active, connected: selected.connected, label: selected.label, pending: Boolean(pending) || account.pending,
      connections, anthropicOAuth: { available: Boolean(command), notice: CLI_NOTICE, installUrl: INSTALL_URL, pending: Boolean(pending), ...(cliError ? { error: cliError } : {}) } };
  }
  const readCredentials = async id => {
    const record = await read(), entry = definitions.find(item => item.id === id);
    if (!entry) throw invalid();
    const base = { id, provider: entry.provider, method: entry.method };
    if (entry.method === 'api') {
      if (!record.keys[id]) throw credentialError();
      return { ...base, ...record.keys[id] };
    }
    if (id === 'openai-oauth') {
      if (!(await oauthStatus()).loggedIn) throw credentialError();
      try { return { ...base, accessToken: await oauth.getAccessToken() }; } catch { throw credentialError(); }
    }
    if (!record.anthropicOAuth) throw credentialError();
    try {
      const result = await cli(['auth', 'print-credentials', '--profile', 'sitecad', '--access-token']);
      const accessToken = result.stdout?.trim();
      if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{16,65536}$/.test(accessToken)) throw credentialError();
      return { ...base, accessToken };
    } catch { throw Error('Claude Console 인증을 갱신하지 못했습니다. 설정에서 다시 로그인해 주세요.'); }
  };
  const cancel = async () => { epoch++; const previous = pending; pending = undefined; previous?.controller.abort(); };
  return {
    status, activeId: async () => (await read()).active, credentials: async () => readCredentials((await read()).active), cancel,
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
      const entry = connection(input); await cancel();
      if (entry.id === 'openai-oauth') {
        try { await oauth.logout(); } catch { throw Error('ChatGPT 로그아웃을 완료하지 못했습니다.'); }
      }
      if (entry.id === 'anthropic-oauth' && (await read()).anthropicOAuth) {
        if (!await findCommand()) throw Error('공식 CLI를 다시 설치한 뒤 Claude Console 로그아웃을 완료해 주세요. 인증 프로필은 아직 보존되어 있습니다.');
        try { await cli(['auth', 'logout', '--profile', 'sitecad']); } catch { throw Error('Claude Console 로그아웃을 완료하지 못했습니다. 다시 시도해 주세요.'); }
      }
      await update(record => ({ ...record, active: record.active === input.id ? 'openai-oauth' : record.active,
        keys: Object.fromEntries(Object.entries(record.keys).filter(([id]) => id !== input.id)),
        anthropicOAuth: input.id === 'anthropic-oauth' ? false : record.anthropicOAuth }));
      checks = new Map([...checks].filter(([id]) => id !== input.id));
      return status();
    },
    async test(input) {
      const entry = connection(input);
      let result;
      try {
        const credentials = await readCredentials(entry.id);
        const response = await fetchImpl(`https://api.${entry.provider === 'openai' ? 'openai' : 'anthropic'}.com/v1/models`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { ...(entry.id === 'anthropic-api' ? { 'x-api-key': credentials.apiKey } : { Authorization: `Bearer ${credentials.apiKey ?? credentials.accessToken}` }),
            ...(entry.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
            ...(entry.id === 'anthropic-oauth' ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
            ...(credentials.workspaceId ? { 'anthropic-workspace-id': credentials.workspaceId } : {}) },
        });
        if (!response.ok) {
          result = { ok: false, status: response.status, message: response.status === 401 || response.status === 403 ? '인증정보 또는 API 사용 권한을 확인해 주세요.' : response.status === 429 ? '요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.' : 'LLM 서비스 연결을 확인하지 못했습니다.' };
          await response.body?.cancel().catch(() => {});
        } else result = { ok: true, modelCount: await readModels(response), message: '모델 목록 연결을 확인했습니다. 실제 모델 실행·과금·권한은 별도입니다.' };
      } catch { result = { ok: false, message: 'LLM 연결을 확인하지 못했습니다. 인증정보·공식 CLI 로그인·네트워크를 확인해 주세요.' }; }
      const check = { ...result, checkedAt: new Date().toISOString() };
      checks = new Map([...checks, [entry.id, check]]);
      return { ...check };
    },
    async login(input) {
      const entry = connection(input);
      if (entry.method !== 'oauth') throw invalid();
      if (entry.id === 'openai-oauth') {
        try { await oauth.login(); return status(); } catch { throw Error('ChatGPT 로그인을 시작하지 못했습니다. 다시 시도해 주세요.'); }
      }
      if (pending) return { ...await status(), pending: true };
      if (!await findCommand()) return { ...await status(), actionNeeded: 'install-anthropic-cli', installUrl: INSTALL_URL, message: '공식 Anthropic CLI를 설치한 뒤 Console OAuth 로그인을 다시 눌러 주세요.' };
      const controller = new AbortController(), generation = epoch;
      const attempt = { controller }; pending = attempt; cliError = undefined;
      attempt.task = (async () => {
        try {
          await cli(['auth', 'login', '--profile', 'sitecad'], { signal: controller.signal, timeout: 300000 });
          if (generation !== epoch || pending !== attempt || controller.signal.aborted) return;
          await update(record => generation === epoch && pending === attempt ? { ...record, anthropicOAuth: true } : null);
        } catch { if (generation === epoch && !controller.signal.aborted) cliError = 'Claude Console 로그인을 완료하지 못했습니다. 공식 CLI 설치·브라우저·네트워크를 확인해 주세요.'; }
        finally { if (pending === attempt) pending = undefined; }
      })();
      return { ...await status(), pending: true };
    },
  };
}
