import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { SKILL_SUBMISSION_ORIGIN } from '../lib/skill-submission.mjs';

async function setup(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, request: (path, init = {}) => fetch(base + path, { ...init, headers: { Origin: base, ...init.headers } }) };
}

test('skill submission routes require local origin, JSON and browser owner before publishing', async t => {
  const calls = [];
  let owned = true;
  const s = await setup(t, { desktop: {}, skillSubmission: {
    config: async () => ({ enabled: true, origin: SKILL_SUBMISSION_ORIGIN }),
    submit: async input => { calls.push(input); return { state: 'submitted', issueUrl: 'https://github.com/seominpapa/SiteCAD/issues/1' }; },
  }, browserAccess: { protect: async () => true, assertOwner: () => { if (!owned) throw Object.assign(Error('다른 탭에서 사용 중입니다.'), { status: 403 }); } } });
  const path = '/api/desktop/skills/submit';
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"consent":true}' };
  assert.equal((await s.request(path, { ...init, headers: { ...init.headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.request(path, { ...init, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  owned = false;
  assert.equal((await s.request(path, init)).status, 403);
  assert.equal(calls.length, 0);
  owned = true;
  const response = await s.request(path, init);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.issueUrl, 'https://github.com/seominpapa/SiteCAD/issues/1');
  assert.deepEqual(calls, [{ consent: true }]);
  const config = await s.request('/api/desktop/skills/submission-config');
  assert.equal((await config.json()).data.enabled, true);
});

test('CSP allows only the fixed submission challenge frame and keeps connections local', async t => {
  const s = await setup(t);
  const response = await s.request('/');
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes(`frame-src 'self' ${SKILL_SUBMISSION_ORIGIN};`));
  assert.ok(csp.includes("connect-src 'self';"));
});
