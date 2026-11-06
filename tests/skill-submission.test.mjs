import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillSubmission, SKILL_SUBMISSION_ORIGIN } from '../lib/skill-submission.mjs';

const submissionId = 'a9d572d0-272e-420d-aef8-8c16045ac8b9';
const challengeNonce = 'b9d572d0-272e-420d-aef8-8c16045ac8b9';
const input = { submissionId, challengeNonce, turnstileToken: 'verified-token', consent: true };
const archive = { name: 'SiteCAD-skills-0.16.5-20261106.zip', bytes: Buffer.from('PK\x03\x04zip'), summary: '자동 생성한 개선 배경' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup(options = {}) {
  const calls = [], builds = [];
  const api = createSkillSubmission({ desktop: { skillsExport: async value => { builds.push(value); return archive; } },
    fetcher: async (url, init) => { calls.push({ url, init }); return url.endsWith('/health') ? json({ ok: true, data: { configured: true } }) : json({ ok: true, data: { submissionId, state: 'submitted', issueUrl: 'https://github.com/seominpapa/SiteCAD/issues/22' } }, 201); }, ...options });
  return { api, calls, builds };
}

test('configuration reports service readiness without exposing server credentials', async () => {
  const f = setup();
  assert.deepEqual(await f.api.config(), { enabled: true, origin: SKILL_SUBMISSION_ORIGIN, challengeUrl: `${SKILL_SUBMISSION_ORIGIN}/challenge` });
  assert.equal(f.calls[0].url, `${SKILL_SUBMISSION_ORIGIN}/health`);
  for (const fetcher of [async () => { throw Error('PRIVATE SECRET'); }, async () => json({ ok: true, data: { configured: false } }), async () => json({}, 503)]) {
    assert.deepEqual(await setup({ fetcher }).api.config(), { enabled: false });
  }
});

test('submission validates consent and fields before exporting or making requests', async () => {
  const f = setup();
  for (const bad of [null, [], {}, { ...input, consent: false }, { ...input, submissionId: '../bad' }, { ...input, challengeNonce: '' }, { ...input, turnstileToken: 'x'.repeat(2049) }, { ...input, chatId: '../bad' }, { ...input, arbitraryUrl: 'https://evil.test' }]) await assert.rejects(f.api.submit(bad));
  assert.equal(f.builds.length, 0);
  assert.equal(f.calls.length, 0);
});

test('submission exports only selected chat, uploads bounded ZIP and accepts fixed repository issue links', async () => {
  const f = setup();
  const chatId = 'c9d572d0-272e-420d-aef8-8c16045ac8b9';
  const result = await f.api.submit({ ...input, chatId });
  assert.equal(result.issueUrl, 'https://github.com/seominpapa/SiteCAD/issues/22');
  assert.deepEqual(f.builds, [{ chatId }]);
  const form = f.calls.at(-1).init.body;
  assert.equal(form.get('archive').name, archive.name);
  assert.deepEqual(Buffer.from(await form.get('archive').arrayBuffer()), archive.bytes);
  assert.deepEqual(JSON.parse(form.get('metadata')), { submissionId, version: '0.16.5', summary: archive.summary });
  assert.equal(form.get('consent'), 'true');
  assert.equal(form.get('turnstileToken'), input.turnstileToken);
  assert.equal(form.get('challengeNonce'), challengeNonce);
  await f.api.submit({ ...input, chatId });
  assert.equal(f.builds.length, 1);
  assert.equal(f.calls.length, 1);
});

test('failed submissions retain the exact archive and ID for retry and never expose upstream error text', async () => {
  let count = 0; const uploads = [];
  const f = setup({ fetcher: async (url, init) => { uploads.push(init.body); return ++count === 1 ? json({ error: 'PRIVATE SECRET' }, 502) : json({ ok: true, data: { submissionId, state: 'pending' } }, 202); } });
  await assert.rejects(f.api.submit(input), error => !error.message.includes('PRIVATE SECRET'));
  const result = await f.api.submit({ ...input, turnstileToken: 'fresh-token' });
  assert.equal(result.state, 'pending');
  assert.equal(f.builds.length, 1);
  assert.deepEqual(Buffer.from(await uploads[0].get('archive').arrayBuffer()), Buffer.from(await uploads[1].get('archive').arrayBuffer()));
  assert.equal(JSON.parse(uploads[1].get('metadata')).submissionId, submissionId);
});

test('unsafe responses, large archive and parallel submits fail safely', async () => {
  for (const data of [{ submissionId, state: 'submitted', issueUrl: 'https://evil.test/issues/1' }, { submissionId, state: 'submitted', issueUrl: 'https://github.com/other/repo/issues/1' }, { submissionId: challengeNonce, state: 'pending' }, { submissionId, state: 'unknown' }]) {
    const f = setup({ fetcher: async () => json({ ok: true, data }) });
    await assert.rejects(f.api.submit(input));
  }
  const huge = setup({ desktop: { skillsExport: async () => ({ ...archive, bytes: Buffer.alloc(19 * 1024 * 1024) }) } });
  await assert.rejects(huge.api.submit(input), /용량|ZIP/);
  let release;
  const f = setup({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  const first = f.api.submit(input);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.api.submit(input), /진행|처리/);
  release(json({ ok: true, data: { submissionId, state: 'pending' } }, 202));
  await first;
});
