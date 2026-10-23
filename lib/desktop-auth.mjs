import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const INVALID_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const ERROR_IDENTITY = 'ChatGPT 로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요.';
const random = () => randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const withoutTokens = ({ accessToken, refreshToken, idToken, expiresAt, scopes, ...identity }) => identity;

function trustedEndpoint(value) {
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.hash) throw new Error(ERROR_IDENTITY);
  return url.href;
}

async function readJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error(ERROR_IDENTITY);
  try { return JSON.parse(text); } catch { throw new Error(ERROR_IDENTITY); }
}

function tokenValues(data, now, previous = {}) {
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 128 * 1024 || typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 128 * 1024 || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error(ERROR_IDENTITY);
  if (data.scope !== undefined && typeof data.scope !== 'string') throw new Error(ERROR_IDENTITY);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token ?? previous.idToken,
    expiresAt: now + data.expires_in * 1000,
    scopes: data.scope === undefined ? previous.scopes ?? [] : [...new Set(data.scope.split(/\s+/).filter(Boolean))],
  };
}

/** Store must atomically protect the complete record; no credentials leave this backend. */
export async function createDesktopAuth({ store, openExternal, fetchImpl = fetch, now = Date.now, onChange = () => {}, timeoutMs = 5 * 60 * 1000, requestTimeoutMs = 20_000 } = {}) {
  if (!store?.read || !store?.write || typeof openExternal !== 'function') throw new TypeError('A protected store and system-browser opener are required.');
  const saved = await store.read();
  let record = saved ?? { hostId: `urn:uuid:${randomUUID()}`, registrations: [], activeClientId: null };
  if (typeof record.hostId !== 'string' || !record.hostId || !Array.isArray(record.registrations)) throw new Error('SiteCAD 로그인 저장소를 읽을 수 없습니다.');
  if (!saved) await store.write(record);
  let pending = null;
  let lastAttempt = Promise.resolve();
  let lastError = null;
  let revocationConfirmed = null;
  let refreshPromise = null;
  let refreshClientId = null;
  let generation = 0;
  let closed = false;
  let writeQueue = Promise.resolve();
  let discovery;
  let jwks;
  let jwksSavedAt = 0;
  const active = () => record.registrations.find(item => item.clientId === record.activeClientId);
  const status = () => {
    const account = active();
    return { loggedIn: Boolean(account?.accessToken), pending: Boolean(pending), sharing: Boolean(account?.accessToken && account.scopes?.includes('chatgpt.tokens.use.direct')), email: account?.email ?? null, accountId: account?.clientId ?? null, accounts: record.registrations.filter(item => item.subject).map(item => ({ accountId: item.clientId, email: item.email ?? null, active: item.clientId === record.activeClientId })), error: lastError, revocationConfirmed };
  };
  const notify = () => { try { onChange(status()); } catch { /* A UI observer cannot invalidate a saved login. */ } };
  const mutate = transform => {
    const task = writeQueue.then(async () => { const next = transform(record); if (next === record) return; await store.write(next); record = next; });
    writeQueue = task.catch(() => {});
    return task;
  };
  const request = (url, init = {}) => fetchImpl(trustedEndpoint(url), { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs) });
  const configuration = async () => {
    if (!discovery) {
      const response = await request(`${ISSUER}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(ERROR_IDENTITY);
      const value = await readJson(response);
      if (value.issuer !== ISSUER) throw new Error(ERROR_IDENTITY);
      discovery = { issuer: value.issuer, authorization_endpoint: trustedEndpoint(value.authorization_endpoint), token_endpoint: trustedEndpoint(value.token_endpoint), jwks_uri: trustedEndpoint(value.jwks_uri), revocation_endpoint: value.revocation_endpoint ? trustedEndpoint(value.revocation_endpoint) : null };
    }
    return discovery;
  };
  const identity = async (token, clientId, nonce, signal) => {
    try {
      if (typeof token !== 'string' || token.length > 128 * 1024) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || header.crit) throw new Error();
      const config = await configuration();
      let key = jwks?.keys?.find(item => item.kid === header.kid);
      if (!key || now() - jwksSavedAt > 5 * 60 * 1000) {
        const response = await request(config.jwks_uri, { signal });
        if (!response.ok) throw new Error();
        jwks = await readJson(response); jwksSavedAt = now();
        key = jwks?.keys?.find(item => item.kid === header.kid);
      }
      if (!key || (key.alg && key.alg !== header.alg) || (key.use && key.use !== 'sig') || (key.key_ops && !key.key_ops.includes('verify')) || (header.alg === 'RS256' && key.kty !== 'RSA') || (header.alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256'))) throw new Error();
      const publicKey = createPublicKey({ key, format: 'jwk' });
      if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) throw new Error();
      const seconds = now() / 1000;
      const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (claims.iss !== ISSUER || !Array.isArray(audience) || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= seconds - 5 || !Number.isFinite(claims.iat) || claims.iat > seconds + 5 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 5)) || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && !same(claims.nonce, nonce))) throw new Error();
      return { subject: claims.sub, issuer: claims.iss, email: typeof claims.email === 'string' ? claims.email : null };
    } catch { throw new Error(ERROR_IDENTITY); }
  };
  const exchange = async (body, signal) => {
    const config = await configuration();
    const response = await request(config.token_endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal });
    const data = await readJson(response);
    if (!response.ok) {
      const error = new Error('ChatGPT 연결을 갱신하지 못했습니다. 다시 시도해 주세요.');
      error.oauthCode = typeof data.error === 'string' ? data.error : null;
      throw error;
    }
    return data;
  };
  const finish = (attempt, error) => {
    if (attempt.finished) return;
    attempt.finished = true;
    clearTimeout(attempt.timer);
    attempt.server?.close();
    attempt.server?.closeIdleConnections();
    attempt.controller.abort();
    if (pending === attempt) pending = null;
    lastError = error?.message ?? null;
    if (error) attempt.reject(error); else attempt.resolve(status());
    notify();
  };
  const cancel = () => { if (pending) finish(pending, new Error('ChatGPT 로그인을 취소했습니다.')); return status(); };
  const completeCallback = async (attempt, url) => {
    if (url.searchParams.has('error')) throw new Error(url.searchParams.get('error') === 'access_denied' ? 'ChatGPT 사용 권한이 승인되지 않았습니다. 다시 로그인해 주세요.' : ERROR_IDENTITY);
    const code = url.searchParams.get('code');
    let clientId = url.searchParams.get('client_id');
    if (!code || code.length > 8192) throw new Error(ERROR_IDENTITY);
    if (attempt.selected) {
      if (clientId && clientId !== attempt.selected.clientId) throw new Error(ERROR_IDENTITY);
      clientId = attempt.selected.clientId;
    } else if (!clientId || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(clientId)) throw new Error(ERROR_IDENTITY);
    if (!attempt.selected) await mutate(current => attempt.finished ? current : { ...current, pendingClientId: clientId });
    const data = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }, attempt.controller.signal);
    const verified = await identity(data.id_token, clientId, attempt.nonce, attempt.controller.signal);
    if (attempt.selected?.subject && (verified.subject !== attempt.selected.subject || verified.issuer !== attempt.selected.issuer)) throw new Error(ERROR_IDENTITY);
    const profile = { clientId, ...verified, ...tokenValues(data, now()) };
    await mutate(current => {
      if (attempt.finished || closed || pending !== attempt) return current;
      const previous = current.registrations.find(item => item.clientId === clientId);
      if (previous?.subject && (previous.subject !== profile.subject || previous.issuer !== profile.issuer)) throw new Error(ERROR_IDENTITY);
      return { ...current, pendingClientId: null, activeClientId: clientId, registrations: [...current.registrations.filter(item => item.clientId !== clientId), profile] };
    });
    finish(attempt);
  };
  const login = async ({ newAccount = false, clientId } = {}) => {
    if (closed) throw new Error('SiteCAD가 종료되었습니다.');
    if (pending) return status();
    const selected = newAccount ? null : clientId ? record.registrations.find(item => item.clientId === clientId) : active() ?? (record.pendingClientId ? { clientId: record.pendingClientId } : null);
    if (clientId && !selected) throw new Error(ERROR_IDENTITY);
    const attempt = { selected, state: random(), nonce: random(), verifier: random(), controller: new AbortController(), finished: false, consumed: false };
    lastAttempt = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject; });
    lastAttempt.catch(() => {});
    pending = attempt; lastError = null; notify();
    try {
      const config = await configuration();
      if (attempt.finished) return status();
      attempt.server = createServer((req, res) => {
        const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' };
        const url = new URL(req.url ?? '/', attempt.redirectUri);
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404, headers).end('Not found'); return; }
        if (req.url.length > 16 * 1024 || req.headers.host !== new URL(attempt.redirectUri).host || attempt.consumed || attempt.finished || !same(url.searchParams.get('state'), attempt.state)) {
          res.writeHead(400, headers).end('로그인을 확인할 수 없습니다. SiteCAD에서 다시 시도해 주세요.');
          finish(attempt, new Error(ERROR_IDENTITY)); return;
        }
        attempt.consumed = true;
        res.writeHead(200, headers).end('SiteCAD로 돌아가 로그인 결과를 확인해 주세요. 이 창을 닫아도 됩니다.');
        completeCallback(attempt, url).catch(() => finish(attempt, new Error(ERROR_IDENTITY)));
      });
      attempt.server.headersTimeout = 10_000;
      attempt.server.requestTimeout = 10_000;
      await new Promise((resolve, reject) => { attempt.server.once('error', reject); attempt.server.listen(0, '127.0.0.1', resolve); });
      if (attempt.finished) { attempt.server.close(); return status(); }
      attempt.redirectUri = `http://127.0.0.1:${attempt.server.address().port}/auth/callback`;
      attempt.timer = setTimeout(() => finish(attempt, new Error('ChatGPT 로그인 시간이 초과되었습니다. 다시 시도해 주세요.')), timeoutMs);
      attempt.timer.unref?.();
      const url = new URL(config.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: selected?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: record.hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') });
      if (!selected) url.searchParams.set('agent_name_hint', 'SiteCAD');
      if (selected?.idToken) url.searchParams.set('id_token_hint', selected.idToken);
      if (selected?.email) url.searchParams.set('login_hint', selected.email);
      try { await openExternal(url.href); } catch { throw new Error('로그인 브라우저를 열 수 없습니다. 다시 시도해 주세요.'); }
      return status();
    } catch (error) {
      const safe = new Error(error.message.includes('브라우저') ? error.message : ERROR_IDENTITY);
      finish(attempt, safe); throw safe;
    }
  };
  const getAccessToken = async () => {
    if (closed) throw new Error('SiteCAD가 종료되었습니다.');
    const account = active();
    if (!account?.accessToken) throw new Error('ChatGPT에 다시 로그인해 주세요.');
    if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT 플랜 사용 권한을 승인해 주세요.');
    if (account.expiresAt > now() + 60_000) return account.accessToken;
    if (refreshPromise) {
      if (refreshClientId === account.clientId) return refreshPromise;
      await refreshPromise.catch(() => {});
      return getAccessToken();
    }
    const epoch = generation;
    const refresh = async () => {
      try {
        const data = await exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
        if (data.id_token) {
          const verified = await identity(data.id_token, account.clientId);
          if (verified.subject !== account.subject || verified.issuer !== account.issuer) throw new Error(ERROR_IDENTITY);
        }
        const tokens = tokenValues(data, now(), account);
        await mutate(current => {
          if (epoch !== generation || current.activeClientId !== account.clientId || current.registrations.find(item => item.clientId === account.clientId)?.refreshToken !== account.refreshToken) throw new Error('로그인 상태가 변경되었습니다. 다시 시도해 주세요.');
          return { ...current, registrations: current.registrations.map(item => item.clientId === account.clientId ? { ...item, ...tokens } : item) };
        });
        notify();
        if (!tokens.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT 플랜 사용 권한을 승인해 주세요.');
        return tokens.accessToken;
      } catch (error) {
        if (INVALID_REFRESH.has(error.oauthCode)) {
          await mutate(current => ({ ...current, registrations: current.registrations.map(item => item.clientId === account.clientId && item.refreshToken === account.refreshToken ? withoutTokens(item) : item) }));
          lastError = 'ChatGPT에 다시 로그인해 주세요.'; notify(); throw new Error(lastError);
        }
        throw new Error(error.message === ERROR_IDENTITY ? ERROR_IDENTITY : 'ChatGPT 연결을 갱신하지 못했습니다. 다시 시도해 주세요.');
      }
    };
    refreshClientId = account.clientId;
    refreshPromise = refresh().finally(() => { refreshPromise = null; refreshClientId = null; });
    return refreshPromise;
  };
  const logout = async () => {
    cancel(); generation++;
    let account;
    revocationConfirmed = null;
    await mutate(current => {
      account = current.registrations.find(item => item.clientId === current.activeClientId);
      return { ...current, registrations: current.registrations.map(item => item.clientId === account?.clientId ? withoutTokens(item) : item) };
    });
    notify();
    if (account?.refreshToken) {
      try {
        const config = await configuration();
        if (!config.revocation_endpoint) throw new Error();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await request(config.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) });
            if (response.status === 200) { revocationConfirmed = true; break; }
            if (response.status < 500) break;
          } catch { /* Retry once before reporting that remote revocation is unconfirmed. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch { /* Local sign-out must complete even when remote revocation is unavailable. */ }
      if (revocationConfirmed !== true) { revocationConfirmed = false; lastError = '이 기기에서는 로그아웃했습니다. 원격 연결 해제는 확인되지 않아 ChatGPT 설정에서 연결을 해제할 수 있습니다.'; }
    }
    notify(); return status();
  };
  return { status, login, waitForLogin: () => lastAttempt, getAccessToken, logout, cancel, close: async () => { closed = true; generation++; cancel(); await writeQueue; } };
}
