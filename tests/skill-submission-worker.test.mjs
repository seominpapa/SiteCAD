import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createWorker } from '../cloudflare/skill-submissions/worker.mjs';
import { githubHeaders } from '../cloudflare/skill-submissions/github.mjs';

const TEST_INSTALLATION_TOKEN = 'installation-secret';

const origin = 'https://sitecad-skills.example.workers.dev';
const id = 'ab109359-1147-48d3-a053-d53fe73ed601';
const nonce = 'f45793bd-73f4-408c-a423-0664342f7b74';
const zip = new Uint8Array([80, 75, 3, 4, ...new Uint8Array(30), 80, 75, 5, 6, ...new Uint8Array(18)]);
class Bucket {
  entries = new Map();
  writes = new Map();
  constructor({ strict = false } = {}) { this.strict = strict; }
  async put(key, bytes, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.entries.has(key)) return null;
    const at = Date.now();
    if (this.strict && at - (this.writes.get(key) ?? -Infinity) < 1000) throw Error('R2 same-key write rate exceeded');
    this.writes.set(key, at);
    const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(await new Response(bytes).arrayBuffer());
    this.entries.set(key, { value, options }); return { key, etag: crypto.randomUUID() };
  }
  async get(key) {
    const item = this.entries.get(key); if (!item) return null;
    return { body: item.value, size: item.value.length, json: async () => JSON.parse(new TextDecoder().decode(item.value)), httpMetadata: item.options.httpMetadata };
  }
}
function fixture({ githubFailure = false, verify = {}, deny = false, reconciled = false, strictR2 = false } = {}) {
  const calls = [];
  const env = { PUBLIC_ORIGIN: origin, GITHUB_OWNER: 'seominpapa', GITHUB_REPO: 'SiteCAD', GITHUB_TOKEN: 'private-test-token', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'private-test-secret', ARCHIVES: new Bucket({ strict: strictR2 }),
    API_LIMITER: { limit: async () => ({ success: !deny }) }, UPLOAD_LIMITER: { limit: async () => ({ success: true }) }, GLOBAL_LIMITER: { limit: async () => ({ success: true }) } };
  let created = 0;
  const worker = createWorker({ fetcher: async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/siteverify')) return Response.json({ success: true, hostname: new URL(origin).hostname, action: 'skill-submit', cdata: nonce, ...verify });
    if (init.method === 'POST') { created++; if (githubFailure) throw Error('upstream private-test-token private-test-secret'); return Response.json({ number: 42, html_url: 'https://github.com/seominpapa/SiteCAD/issues/42' }); }
    return Response.json(reconciled ? [{ number: 42, html_url: 'https://github.com/seominpapa/SiteCAD/issues/42', body: `<!-- sitecad-submission:${id} -->` }] : []);
  } });
  const request = (path, init) => worker.fetch(new Request(origin + path, init), env);
  const submit = (changes = {}, fields = {}) => {
    const form = new FormData();
    form.set('archive', new File([zip], 'SiteCAD-skills-0.16.5-20261106.zip', { type: 'application/zip' }));
    form.set('metadata', JSON.stringify({ submissionId: id, version: '0.16.5', summary: '철근 기호 검토 실패를 개선', ...changes }));
    form.set('turnstileToken', 'verified-token'); form.set('challengeNonce', nonce); form.set('consent', 'true');
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return request('/submissions', { method: 'POST', body: form });
  };
  return { env, calls, request, submit, created: () => created };
}

test('unconfigured service fails closed and never returns a credential', async () => {
  const f = fixture(); delete f.env.GITHUB_TOKEN;
  const health = await f.request('/health'); assert.deepEqual(await health.json(), { ok: true, data: { configured: false } });
  assert.equal((await f.submit()).status, 503);
  assert.equal(f.calls.length, 0);
});

test('challenge restricts parent to loopback, posts nonce-bound tokens and exposes no secret', async () => {
  const f = fixture();
  const response = await f.request(`/challenge?origin=${encodeURIComponent('http://127.0.0.1:4567')}&nonce=${nonce}`);
  assert.equal(response.status, 200);
  const text = await response.text(); assert.match(text, /sitecad-skill-verification/); assert.match(text, /http:\/\/127\.0\.0\.1:4567/); assert.match(text, /skill-submit/); assert.doesNotMatch(text, /private-test/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors/);
  for (const parent of ['https://evil.example', 'http://127.0.0.1:4567/evil', 'http://localhost.evil:4567']) assert.equal((await f.request(`/challenge?origin=${encodeURIComponent(parent)}&nonce=${nonce}`)).status, 400);
});

test('challenge reports real failure and expiry to the exact parent with visible recovery guidance', async () => {
  const f = fixture();
  const response = await f.request(`/challenge?origin=${encodeURIComponent('http://127.0.0.1:4567')}&nonce=${nonce}`);
  const html = await response.text(), posted = [], status = { textContent: '' };
  let options;
  const scope = { document: { getElementById: () => status }, parent: { postMessage: (message, target) => posted.push({ message, target }) }, window: {}, turnstile: { render(selector, value) { assert.equal(selector, '#verification'); options = value; } } };
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], scope);
  scope.window.sitecadReady();
  assert.equal(options['error-callback']('300030'), true);
  assert.equal(posted.at(-1).message.token, '');
  assert.equal(posted.at(-1).message.reason, 'failed');
  assert.equal(posted.at(-1).message.nonce, nonce);
  assert.equal(posted.at(-1).target, 'http://127.0.0.1:4567');
  assert.match(status.textContent, /실패.*다시/);
  options['expired-callback']();
  assert.equal(posted.at(-1).message.reason, 'expired');
  assert.match(status.textContent, /만료/);
  options.callback('actual-verified-token');
  assert.equal(posted.at(-1).message.token, 'actual-verified-token');
  assert.match(status.textContent, /완료/);
});

test('submission checks consent, bounded metadata, token binding and ZIP before storing', async () => {
  const f = fixture();
  for (const changes of [{ submissionId: '../bad' }, { version: 'not-a-version' }, { summary: 'x'.repeat(8001) }, { url: 'https://evil.example' }]) assert.equal((await f.submit(changes)).status, 400);
  assert.equal((await f.submit({}, { consent: 'false' })).status, 400);
  assert.equal((await f.submit({}, { archive: new File(['bad'], 'SiteCAD-skills-0.16.5.zip') })).status, 400);
  assert.equal((await f.submit({}, { turnstileToken: 'x'.repeat(2049) })).status, 400);
  assert.equal(f.env.ARCHIVES.entries.size, 0);
  for (const verify of [{ success: false }, { hostname: 'evil.example' }, { action: 'login' }, { cdata: 'other' }]) {
    const rejected = fixture({ verify }); assert.equal((await rejected.submit()).status, 403); assert.equal(rejected.env.ARCHIVES.entries.size, 0);
  }
});

test('bounded request reading rejects oversized bytes including missing Content-Length', async () => {
  const f = fixture();
  const response = await f.request('/submissions', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: new Uint8Array(18 * 1024 * 1024 + 32769) });
  assert.equal(response.status, 413); assert.equal(f.calls.length, 0);
});

test('verified archive creates one issue and only submitted ZIP can be downloaded', async () => {
  const f = fixture();
  assert.equal((await f.request(`/downloads/${id}`)).status, 404);
  const response = await f.submit(); assert.equal(response.status, 201);
  const result = await response.json(); assert.equal(result.data.state, 'submitted'); assert.equal(result.data.issueUrl, 'https://github.com/seominpapa/SiteCAD/issues/42');
  const issue = JSON.parse(f.calls.find(x => x.url.endsWith('/issues')).init.body);
  assert.match(issue.body, /철근 기호/); assert.match(issue.body, new RegExp(id)); assert.match(issue.body, /downloads/);
  const download = await f.request(`/downloads/${id}`); assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip'); assert.match(download.headers.get('content-disposition'), /attachment/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), zip);
  assert.doesNotMatch(JSON.stringify(result), /private-test|verified-token/);
});

test('a complete submission and reconciliation never rewrite the same R2 object within one second', async () => {
  const f = fixture({ strictR2: true });
  assert.equal((await f.submit()).status, 201);
  assert.equal((await f.submit()).status, 200);
  assert.equal((await f.request(`/downloads/${id}`)).status, 200);
  const recovery = fixture({ strictR2: true, githubFailure: true, reconciled: true });
  assert.equal((await recovery.submit()).status, 202);
  assert.equal((await recovery.submit()).status, 200);
  assert.equal((await recovery.submit()).status, 200);
  assert.equal(recovery.created(), 1);
});

test('retries and concurrent submissions never create duplicate issues', async () => {
  const f = fixture();
  const results = await Promise.all([f.submit(), f.submit()]);
  assert.ok(results.every(x => [201, 202, 200].includes(x.status))); assert.equal(f.created(), 1);
  const retried = await f.submit(); assert.equal(retried.status, 200); assert.equal((await retried.json()).data.state, 'submitted'); assert.equal(f.created(), 1);
  assert.equal((await f.submit({ summary: 'changed contents' })).status, 409);
});

test('ambiguous GitHub failure stays pending; retries reconcile without creating another issue or leaking secrets', async () => {
  const f = fixture({ githubFailure: true });
  const response = await f.submit(); assert.equal(response.status, 202); const text = await response.text(); assert.match(text, /pending/); assert.doesNotMatch(text, /private-test/);
  assert.equal((await f.request(`/downloads/${id}`)).status, 404);
  const retry = await f.submit(); assert.equal(retry.status, 202); assert.equal(f.created(), 1);
});

test('rate limits apply before challenge verification or archive processing', async () => {
  const f = fixture({ deny: true }); assert.equal((await f.submit()).status, 429); assert.equal(f.calls.length, 0);
});

test('configured health, unknown routes and malformed challenges expose only safe responses', async () => {
  const f = fixture(); assert.deepEqual(await (await f.request('/health')).json(), { ok: true, data: { configured: true } });
  assert.equal((await f.request('/unknown')).status, 404);
  assert.equal((await f.request('/submissions', { method: 'GET' })).status, 404);
  assert.equal((await f.request('/challenge?origin=http%3A%2F%2Flocalhost%3A4000&nonce=bad')).status, 400);
  assert.equal((await f.request('/challenge?origin=not-url&nonce=bad')).status, 400);
  assert.equal((await f.request('/submissions', { method: 'POST', body: 'bad' })).status, 415);
  f.env.UPLOAD_LIMITER.limit = async () => ({ success: false }); assert.equal((await f.submit()).status, 429);
});

test('a retry recovers an issue accepted by GitHub before the response was lost', async () => {
  const f = fixture({ githubFailure: true, reconciled: true });
  assert.equal((await f.submit()).status, 202);
  const retry = await f.submit(); assert.equal(retry.status, 200); assert.equal((await retry.json()).data.issueUrl, 'https://github.com/seominpapa/SiteCAD/issues/42');
  assert.equal(f.created(), 1); assert.equal((await f.request(`/downloads/${id}`)).status, 200);
  const head = await f.request(`/downloads/${id}`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('GitHub App uses a short RS256 JWT and repository-limited installation token without client exposure', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GITHUB_APP_ID: '12345', GITHUB_INSTALLATION_ID: '6789', GITHUB_REPO: 'SiteCAD', GITHUB_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const now = Date.now();
  const headers = await githubHeaders(env, async (url, init) => {
    assert.equal(url, 'https://api.github.com/app/installations/6789/access_tokens');
    assert.deepEqual(JSON.parse(init.body), { repositories: ['SiteCAD'], permissions: { issues: 'write' } });
    const [header, claims, signature] = init.headers.Authorization.slice(7).split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    const payload = JSON.parse(Buffer.from(claims, 'base64url')); assert.equal(payload.iss, '12345'); assert.equal(payload.iat, Math.floor(now / 1000) - 60); assert.equal(payload.exp, Math.floor(now / 1000) + 540);
    const verifyKey = await crypto.subtle.importKey('spki', publicKey.export({ format: 'der', type: 'spki' }), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', verifyKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claims}`)), true);
    return Response.json({ token: TEST_INSTALLATION_TOKEN });
  }, now);
  assert.equal(headers.Authorization, 'Bearer installation-secret');
});
