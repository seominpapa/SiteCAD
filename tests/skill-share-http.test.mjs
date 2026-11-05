import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const background = { situation: '철근 도면 검토', problem: '기호를 직경과 연결하지 못함', changeReason: '범례를 먼저 조회하도록 개선', examplePrompt: '철근 물량 검증해줘', expectedResult: '직경별 길이와 중량 비교표' };

test('skill ZIP export uses an owner-checked same-origin POST and binary attachment', async t => {
  const calls = [];
  const app = createApp({ desktop: {
    skillsExport: async input => { calls.push(input); return { name: 'SiteCAD-skills-0.16.4.zip', bytes: Buffer.from('PK\x03\x04zip') }; },
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const input = {chatId:'selected-chat'};
  const post = headers => fetch(`${base}/api/desktop/skills/export`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await fetch(`${base}/api/desktop/skills/export`)).status, 403);
  assert.equal((await post({ Origin: 'https://elsewhere.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
  const response = await post({ Origin: base, 'Content-Type': 'application/json' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="SiteCAD-skills-0.16.4.zip"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'PK\x03\x04zip');
  assert.deepEqual(calls, [input]);
});

test('browser ownership must be valid before a skill archive is built', async t => {
  let builds = 0;
  const app = createApp({ desktop: { skillsExport: async () => { builds++; } }, browserAccess: {
    protect: async () => true,
    assertOwner: () => { throw Object.assign(Error('연결이 만료되었습니다.'), { status: 403 }); },
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${base}/api/desktop/skills/export`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(background) });
  assert.equal(response.status, 403);
  assert.equal(builds, 0);
});
