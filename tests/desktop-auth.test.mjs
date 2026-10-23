import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { createDesktopAuth } from '../lib/desktop-auth.mjs';

const ISSUER = 'https://auth.openai.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const clock = 1792600000000;
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwt = (claims, key = privateKey) => {
  const prefix = [ { alg: 'RS256', kid: 'test-key' }, claims ].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${prefix}.${createSign('RSA-SHA256').update(prefix).sign(key).toString('base64url')}`;
};

async function fixture(options = {}) {
  let saved = options.saved ?? null;
  let authUrl;
  let tokenHandler;
  const calls = [];
  const auth = await createDesktopAuth({
    store: { read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } },
    openExternal: async url => { authUrl = new URL(url); if (options.openError) throw new Error('private browser error'); },
    now: () => clock,
    timeoutMs: options.timeoutMs ?? 5000,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` });
      if (String(url).endsWith('jwks.json')) return Response.json({ keys: [jwk] });
      if (String(url).endsWith('oauth/revoke')) return new Response('', { status: options.revokeFail ? 503 : 200 });
      if (tokenHandler) return tokenHandler(init);
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('resource'), 'https://api.openai.com/v1');
      const id = jwt({ iss: ISSUER, aud: 'oaiapp_sitecad_test', sub: 'user-one', email: 'one@example.test', iat: clock / 1000, exp: clock / 1000 + 3600, nonce: authUrl.searchParams.get('nonce'), ...options.claims });
      return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: id, token_type: 'Bearer', expires_in: 3600, scope: options.scope ?? scope });
    },
  });
  const callback = async params => {
    const url = new URL(authUrl.searchParams.get('redirect_uri'));
    url.search = new URLSearchParams({ state: authUrl.searchParams.get('state'), code: 'secret-code', client_id: 'oaiapp_sitecad_test', ...params });
    return fetch(url);
  };
  return { auth, callback, calls, get url() { return authUrl; }, get saved() { return saved; }, setHandler(handler) { tokenHandler = handler; } };
}

test('dynamic registration validates real signed identity and keeps tokens backend only', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  assert.equal(f.auth.status().loggedIn, false);
  const initial = await f.auth.login();
  assert.equal(initial.pending, true);
  assert.equal(f.url.hostname, 'auth.openai.com');
  assert.equal(f.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.url.searchParams.get('agent_name_hint'), 'SiteCAD');
  assert.match(f.url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const response = await f.callback(); assert.equal(response.status, 200);
  await f.auth.waitForLogin();
  assert.equal(f.auth.status().loggedIn, true);
  assert.equal(f.auth.status().sharing, true);
  assert.equal(await f.auth.getAccessToken(), 'secret-access');
  assert.equal(f.saved.registrations[0].subject, 'user-one');
  assert.doesNotMatch(JSON.stringify(f.auth.status()), /secret-|id_token|refresh_token/);
  const exchange = f.calls.find(v => v.url.endsWith('oauth/token'));
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(form.get('client_id'), 'oaiapp_sitecad_test');
  assert.equal(form.get('redirect_uri'), f.url.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), f.url.searchParams.get('code_challenge'));
});

for (const [name, claims] of Object.entries({ issuer: { iss: 'https://evil.test' }, audience: { aud: 'other' }, nonce: { nonce: 'wrong' }, expired: { exp: clock / 1000 - 60 }, future: { iat: clock / 1000 + 600 }, subject: { sub: '' } })) {
  test(`rejects invalid ID token ${name}`, async t => {
    const f = await fixture({ claims }); t.after(() => f.auth.close());
    await f.auth.login(); await f.callback();
    await assert.rejects(f.auth.waitForLogin(), /확인/);
    assert.equal(f.auth.status().loggedIn, false);
    assert.doesNotMatch(f.auth.status().error, /secret-/);
  });
}

test('state mismatch never exchanges code; failed browser launch and timeout close listener', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login(); const response = await f.callback({ state: 'incorrect' });
  assert.equal(response.status, 400);
  await assert.rejects(f.auth.waitForLogin(), /확인/);
  assert.equal(f.calls.filter(v => v.url.endsWith('oauth/token')).length, 0);
  const browser = await fixture({ openError: true }); t.after(() => browser.auth.close());
  await assert.rejects(browser.auth.login(), /브라우저/);
  assert.equal(browser.auth.status().pending, false);
  const timeout = await fixture({ timeoutMs: 10 }); t.after(() => timeout.auth.close());
  await timeout.auth.login(); await assert.rejects(timeout.auth.waitForLogin(), /시간/);
});

test('permission must be granted by token response, never callback', async t => {
  const f = await fixture({ scope: 'openid profile email' }); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback({ scope }); await f.auth.waitForLogin();
  assert.equal(f.auth.status().loggedIn, true);
  assert.equal(f.auth.status().sharing, false);
  await assert.rejects(f.auth.getAccessToken(), /권한/);
});

test('refresh serialized, rotating tokens atomically saved, no scope in refresh request', async t => {
  const initial = await fixture(); await initial.auth.login(); await initial.callback(); await initial.auth.waitForLogin();
  const saved = initial.saved; await initial.auth.close(); saved.registrations[0].expiresAt = clock;
  const f = await fixture({ saved }); t.after(() => f.auth.close());
  let refreshes = 0;
  f.setHandler(async init => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), 'oaiapp_sitecad_test');
    assert.equal(body.has('scope'), false);
    refreshes++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer', scope });
  });
  assert.deepEqual(await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken()]), ['new-access', 'new-access']);
  assert.equal(refreshes, 1);
  assert.equal(f.saved.registrations[0].refreshToken, 'new-refresh');
});

test('returning login bound to client and subject; failure preserves old active session', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback(); await f.auth.waitForLogin();
  const host = f.saved.hostId;
  await f.auth.login();
  assert.equal(f.url.searchParams.get('client_id'), 'oaiapp_sitecad_test');
  assert.equal(f.url.searchParams.has('agent_name_hint'), false);
  assert.equal(f.url.searchParams.get('ext_agent_host_id'), host);
  assert.ok(f.url.searchParams.get('id_token_hint'));
  await f.callback({ client_id: 'attacker-client' }); await assert.rejects(f.auth.waitForLogin());
  assert.equal(await f.auth.getAccessToken(), 'secret-access');
});

test('invalid refresh clears secrets but retains registration; logout revokes and preserves host', async t => {
  const first = await fixture(); await first.auth.login(); await first.callback(); await first.auth.waitForLogin();
  const saved = first.saved; await first.auth.close(); saved.registrations[0].expiresAt = clock;
  const f = await fixture({ saved }); t.after(() => f.auth.close());
  f.setHandler(async () => Response.json({ error: 'invalid_grant', error_description: 'secret-internal' }, { status: 400 }));
  await assert.rejects(f.auth.getAccessToken(), /다시 로그인/);
  assert.equal(f.auth.status().loggedIn, false);
  assert.equal(f.saved.registrations[0].clientId, 'oaiapp_sitecad_test');
  assert.doesNotMatch(JSON.stringify(f.saved), /secret-access|secret-refresh/);
  const logout = await fixture(); t.after(() => logout.auth.close());
  await logout.auth.login(); await logout.callback(); await logout.auth.waitForLogin();
  const host = logout.saved.hostId; await logout.auth.logout();
  assert.equal(logout.saved.hostId, host);
  assert.equal(logout.auth.status().loggedIn, false);
  assert.ok(logout.calls.some(v => v.url.endsWith('oauth/revoke')));
  assert.doesNotMatch(JSON.stringify(logout.saved), /secret-access|secret-refresh/);
});

test('rejects unsigned and forged tokens, missing issued client and OAuth denial', async t => {
  for (const token of ['eyJhbGciOiJub25lIn0.e30.eA', jwt({ iss: ISSUER, aud: 'oaiapp_sitecad_test', sub: 'attacker', exp: clock / 1000 + 3600, iat: clock / 1000 }).replace(/.$/, 'x')]) {
    const f = await fixture(); t.after(() => f.auth.close());
    await f.auth.login();
    f.setHandler(async () => Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: token, token_type: 'Bearer', expires_in: 3600, scope }));
    await f.callback(); await assert.rejects(f.auth.waitForLogin());
    assert.equal(f.auth.status().loggedIn, false);
  }
  for (const params of [{ client_id: '' }, { error: 'access_denied' }]) {
    const f = await fixture(); t.after(() => f.auth.close());
    await f.auth.login(); await f.callback(params); await assert.rejects(f.auth.waitForLogin());
    assert.equal(f.calls.filter(v => v.url.endsWith('oauth/token')).length, 0);
  }
});

test('cancel closes callback listener and cannot overwrite an active session', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback(); await f.auth.waitForLogin();
  await f.auth.login({ newAccount: true });
  assert.equal(f.url.searchParams.get('client_id'), 'dynamic_agent_client');
  f.auth.cancel(); await assert.rejects(f.auth.waitForLogin(), /취소/);
  assert.equal(await f.auth.getAccessToken(), 'secret-access');
  await assert.rejects(f.callback());
  await f.auth.close(); await assert.rejects(f.auth.login(), /종료/);
});

test('verified returning identity cannot change subject even with same email', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback(); await f.auth.waitForLogin();
  await f.auth.login();
  f.setHandler(async () => Response.json({ access_token: 'attacker-access', refresh_token: 'attacker-refresh', id_token: jwt({ iss: ISSUER, aud: 'oaiapp_sitecad_test', sub: 'other-user', email: 'one@example.test', iat: clock / 1000, exp: clock / 1000 + 3600, nonce: f.url.searchParams.get('nonce') }), token_type: 'Bearer', expires_in: 3600, scope }));
  await f.callback({ client_id: '' }); await assert.rejects(f.auth.waitForLogin());
  assert.equal(await f.auth.getAccessToken(), 'secret-access');
  assert.equal(f.saved.registrations[0].subject, 'user-one');
});

test('transient refresh failure retains credentials and retries on next request', async t => {
  const first = await fixture(); await first.auth.login(); await first.callback(); await first.auth.waitForLogin();
  const saved = first.saved; await first.auth.close(); saved.registrations[0].expiresAt = clock;
  const f = await fixture({ saved }); t.after(() => f.auth.close());
  f.setHandler(async () => Response.json({ error: 'server_error', error_description: 'secret-details' }, { status: 503 }));
  await assert.rejects(f.auth.getAccessToken(), /갱신/);
  assert.equal(f.saved.registrations[0].refreshToken, 'secret-refresh');
  f.setHandler(async () => Response.json({ access_token: 'recovered', refresh_token: 'rotated', expires_in: 3600, token_type: 'Bearer' }));
  assert.equal(await f.auth.getAccessToken(), 'recovered');
});

test('logout during in-flight refresh cannot resurrect credentials', async t => {
  const first = await fixture(); await first.auth.login(); await first.callback(); await first.auth.waitForLogin();
  const saved = first.saved; await first.auth.close(); saved.registrations[0].expiresAt = clock;
  const f = await fixture({ saved }); t.after(() => f.auth.close());
  let resolveToken;
  const started = new Promise(resolve => f.setHandler(async () => { resolve(); return new Promise(done => { resolveToken = done; }); }));
  const refresh = f.auth.getAccessToken(); await started;
  await f.auth.logout();
  resolveToken(Response.json({ access_token: 'resurrected', refresh_token: 'bad-refresh', expires_in: 3600, token_type: 'Bearer', scope }));
  await assert.rejects(refresh);
  assert.equal(f.auth.status().loggedIn, false);
  assert.doesNotMatch(JSON.stringify(f.saved), /resurrected|secret-access|secret-refresh/);
});

test('failed remote revocation reports safe warning after local secrets cleared', async t => {
  const f = await fixture({ revokeFail: true }); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback(); await f.auth.waitForLogin();
  const result = await f.auth.logout();
  assert.equal(result.revocationConfirmed, false);
  assert.equal(result.loggedIn, false);
  assert.match(result.error, /원격/);
  assert.equal(f.calls.filter(v => v.url.endsWith('oauth/revoke')).length, 2);
  assert.doesNotMatch(JSON.stringify(f.saved), /secret-access|secret-refresh/);
});

test('callback ignores unrelated requests, sign-out retains issued client without token hints', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await assert.rejects(f.auth.getAccessToken(), /로그인/);
  await assert.rejects(f.auth.login({ clientId: 'unknown' }));
  await f.auth.login();
  const originalState = f.url.searchParams.get('state');
  assert.equal((await fetch(new URL('/favicon.ico', f.url.searchParams.get('redirect_uri')))).status, 404);
  await f.auth.login(); assert.equal(f.url.searchParams.get('state'), originalState);
  await f.callback(); await f.auth.waitForLogin(); await f.auth.logout();
  await f.auth.login();
  assert.equal(f.url.searchParams.get('client_id'), 'oaiapp_sitecad_test');
  assert.equal(f.url.searchParams.has('id_token_hint'), false);
  assert.equal(f.url.searchParams.has('agent_name_hint'), false);
  f.auth.cancel(); await assert.rejects(f.auth.waitForLogin());
});

test('rejects incomplete token response and refresh ID token from another subject', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login();
  f.setHandler(async () => Response.json({ access_token: 'secret-access', id_token: 'invalid', token_type: 'Bearer', expires_in: 3600, scope }));
  await f.callback(); await assert.rejects(f.auth.waitForLogin());
  const first = await fixture(); await first.auth.login(); await first.callback(); await first.auth.waitForLogin();
  const saved = first.saved; await first.auth.close(); saved.registrations[0].expiresAt = clock;
  const next = await fixture({ saved }); t.after(() => next.auth.close());
  next.setHandler(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: jwt({ iss: ISSUER, aud: 'oaiapp_sitecad_test', sub: 'other', iat: clock / 1000, exp: clock / 1000 + 3600 }), token_type: 'Bearer', expires_in: 3600, scope }));
  await assert.rejects(next.auth.getAccessToken(), /확인/);
  assert.equal(next.saved.registrations[0].accessToken, 'secret-access');
});

test('protected store and browser adapter are mandatory; corrupt records fail closed', async () => {
  await assert.rejects(createDesktopAuth(), /protected store/);
  await assert.rejects(fixture({ saved: { hostId: '', registrations: [] } }), /저장소/);
});

test('new account keeps separate registration even with identical email', async t => {
  const f = await fixture(); t.after(() => f.auth.close());
  await f.auth.login(); await f.callback(); await f.auth.waitForLogin();
  await f.auth.login({ newAccount: true });
  f.setHandler(async () => Response.json({ access_token: 'second-access', refresh_token: 'second-refresh', id_token: jwt({ iss: ISSUER, aud: 'oaiapp_second', sub: 'user-two', email: 'one@example.test', iat: clock / 1000, exp: clock / 1000 + 3600, nonce: f.url.searchParams.get('nonce') }), token_type: 'Bearer', expires_in: 3600, scope }));
  await f.callback({ client_id: 'oaiapp_second' }); await f.auth.waitForLogin();
  assert.equal(f.saved.registrations.length, 2);
  assert.equal(f.auth.status().accountId, 'oaiapp_second');
  assert.equal(await f.auth.getAccessToken(), 'second-access');
  assert.equal(f.saved.registrations.find(item => item.clientId === 'oaiapp_sitecad_test').accessToken, 'secret-access');
  assert.equal(f.auth.status().accounts.length, 2);
});
