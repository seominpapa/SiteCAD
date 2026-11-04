import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sitecad-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'private-codex');
  return { root, codexHome, store: await createSitecadSkills({ codexHome }) };
}

const draft = { name: 'drawing-review', description: '도면의 레이어와 물량을 검토할 때 사용합니다.', body: '# 도면 검토\n\n도면 상태와 실제 객체를 조회하고 물량을 표로 정리합니다.' };

test('default quantity review and skill management seed privately and preserve existing files', async t => {
  const { store, codexHome } = await setup(t);
  await store.seed();
  const skills = await store.list();
  assert.deepEqual(skills.map(skill => skill.name), ['design-review', 'progress-markup', 'quantity-review', 'skill-creator', 'skill-finder', 'skill-installer']);
  for (const skill of skills) {
    assert.equal(skill.builtin, true);
    assert.ok(skill.displayName && skill.displayName !== skill.name);
    assert.equal(skill.path, join(codexHome, 'skills', skill.name, 'SKILL.md'));
    assert.match(skill.hash, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') assert.equal((await stat(skill.path)).mode & 0o777, 0o600);
    assert.ok((await store.read(skill.name)).body.includes('sitecad_'));
  }
  const quantity = skills.find(skill => skill.name === 'quantity-review');
  const original = await readFile(quantity.path, 'utf8');
  const changed = `${original}\nUser-maintained quantity review policy.\n`;
  await writeFile(quantity.path, changed);
  await store.seed();
  assert.equal(await readFile(quantity.path, 'utf8'), changed);
  await assert.rejects(store.save({ ...draft, name: 'skill-creator' }), /기본 스킬/);
});

test('six builtins resolve natural requests, names and compound work without treating source data as instructions', async t => {
  const { store } = await setup(t);
  await store.seed();
  const cases = [
    ['현재 도면의 콘크리트와 철근 물량을 산출해줘', ['quantity-review']],
    ['철근 단위중량이 맞는지 검산해줘', ['quantity-review']],
    ['철근 단중 검증해줘', ['quantity-review']],
    ['벽체 콘크리트 물량 산출해줘', ['quantity-review']],
    ['등고선으로 토공량 산정해줘', ['quantity-review']],
    ['건축자재 수량 검증해줘', ['quantity-review']],
    ['강봉 중량 계산해줘', ['quantity-review']],
    ['KDS와 KCS에 맞는지 피복두께와 겹이음을 검토해줘', ['design-review']],
    ['설계오류 찾아줘', ['design-review']],
    ['뒷채움 경사가 맞는지 검토해줘', ['design-review']],
    ['기초 콘크리트 타설 완료', ['progress-markup']],
    ['기성도면 그려줘', ['progress-markup']],
    ['이 절차를 스킬로 만들어줘', ['skill-creator']],
    ['기존 물량 산출 스킬을 수정해줘', ['skill-creator']],
    ['설계기준 검토 스킬 내용을 변경해줘', ['skill-creator']],
    ['기성도면 표시 스킬의 절차를 보완해줘', ['skill-creator']],
    ['물량검토에 맞는 스킬 찾아줘', ['skill-finder']],
    ['이 URL의 스킬을 설치해줘 https://example.org/skill', ['skill-installer']],
    ['물량 산출·검증 스킬을 사용해줘', ['quantity-review']],
    ['design-review로 검토해줘', ['design-review']],
    ['물량 산출 스킬로 도면을 수정하고 물량을 검증해줘', ['quantity-review']],
    ['물량 계산하고 설계기준 확인한 다음 기성 청구 범위 표시해줘', ['quantity-review', 'design-review', 'progress-markup']],
  ];
  for (const [message, expected] of cases) {
    const resolved = await store.resolve(message);
    assert.deepEqual(resolved?.skills.map(item => item.name), expected, message);
    for (const item of resolved.skills) assert.equal(item.path, (await store.read(item.name)).path);
  }
  for (const message of ['도면을 열어줘', '오늘 날씨 알려줘', '이전 작업 계속해줘']) assert.equal(await store.resolve(message), null, message);
  const explicit = await store.resolve('/skill-finder 물량 산출하고 기성 표시해줘');
  assert.equal(explicit.skill.name, 'skill-finder');
  assert.equal(explicit.skills, undefined, 'Explicit slash input must keep its existing single-skill contract.');
});

test('builtin upgrades replace only the known shipped legacy content and preserve user edits', async t => {
  const { store, codexHome } = await setup(t);
  await store.seed();
  const current = await store.read('skill-installer');
  const shipped = await readFile(new URL('./fixtures/skill-installer-v0161.md', import.meta.url), 'utf8');
  assert.notEqual(await readFile(current.path, 'utf8'), shipped, 'The fixture must exercise a real upgrade from the old shipped instructions.');
  await writeFile(current.path, shipped);
  await store.seed();
  assert.equal((await store.read('skill-installer')).hash, current.hash);
  const edited = `${shipped}\nUser-maintained local installation instructions.\n`;
  await writeFile(current.path, edited);
  await store.seed();
  assert.equal(await readFile(current.path, 'utf8'), edited);
  assert.equal((await store.read('skill-installer')).path, join(codexHome, 'skills', 'skill-installer', 'SKILL.md'));
});

test('quantity review is discoverable and immutable while existing private workflows survive seeding', async t => {
  const { store } = await setup(t);
  const custom = await store.save(draft);
  await store.seed();
  const review = await store.read('quantity-review');
  assert.equal(review.builtin, true);
  assert.equal((await store.find('철근')).some(skill => skill.name === review.name), true);
  const resolved = await store.resolve('/quantity-review 현재 도면 철근을 mm 기준으로 검증');
  assert.equal(resolved.skill.name, review.name);
  assert.equal(resolved.skill.path, review.path);
  assert.equal((await store.read(draft.name)).hash, custom.hash);
  await assert.rejects(store.save({ ...draft, name: review.name, expectedHash: review.hash }), /기본 스킬/);
  await assert.rejects(store.remove(review.name, review.hash), /기본 스킬/);
});

test('bundled review recovery asks for handling rules before approved reusable skill registration', async t => {
  const { store } = await setup(t);
  await store.seed();
  const creator = (await store.read('skill-creator')).body;
  const review = (await store.read('quantity-review')).body;
  assert.match(creator, /원하는 결과.*처리 방법.*질문/);
  assert.match(creator, /사용자가 동의한 절차/);
  assert.match(creator, /실패.*등록 동의.*아니/);
  assert.match(creator, /문서 식별자.*객체 핸들/);
  assert.match(review, /GFM.*코드 블록.*사용하지/);
  assert.match(review, /원하는 결과.*처리 방법.*질문/);
  assert.match(review, /skill-creator/);
});

test('skill creation is private, discoverable, immutable to callers and hash guarded on update', async t => {
  const { store, codexHome } = await setup(t);
  const saved = await store.save(draft);
  assert.equal(saved.name, draft.name);
  assert.equal(saved.builtin, false);
  assert.equal(saved.path, join(codexHome, 'skills', draft.name, 'SKILL.md'));
  const raw = await readFile(saved.path, 'utf8');
  assert.ok(raw.startsWith('---\nname: "drawing-review"\ndescription: '));
  if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  assert.equal((await store.read(draft.name)).body, draft.body);
  saved.description = 'external mutation';
  assert.equal((await store.list())[0].description, draft.description);
  await assert.rejects(store.save({ ...draft, body: '다른 검토' }), /변경|덮어/);
  await assert.rejects(store.save({ ...draft, expectedHash: '0'.repeat(64) }), /변경|덮어/);
  const current = await store.read(draft.name);
  const next = await store.save({ ...draft, body: '새로운 검토 순서', expectedHash: current.hash });
  assert.notEqual(next.hash, current.hash);
  assert.equal((await store.read(draft.name)).body, '새로운 검토 순서');
  await assert.rejects(store.save({ ...draft, name: 'missing', expectedHash: current.hash }), /변경|덮어/);
});

test('slash resolution accepts only installed IDs and keeps user arguments as data', async t => {
  const { store } = await setup(t);
  await store.save(draft);
  assert.equal(await store.resolve('도면을 검토해 줘'), null);
  const resolved = await store.resolve('/drawing-review 현재 레이어 "A"만\n단위는 유지');
  assert.deepEqual(resolved.skill, { name: draft.name, path: (await store.read(draft.name)).path });
  assert.equal(resolved.name, draft.name);
  assert.equal(resolved.args, '현재 레이어 "A"만\n단위는 유지');
  assert.equal(resolved.message, resolved.args);
  assert.equal((await store.resolve('/drawing-review')).message, '/drawing-review');
  await assert.rejects(store.resolve('/unknown 값'), /설치된 스킬/);
  await assert.rejects(store.resolve('/../escape 값'), /스킬/);
  await assert.rejects(store.resolve(null), /스킬/);
  assert.equal((await store.find('레이어 물량')).length, 1);
  assert.deepEqual(await store.find('없는이름'), []);
});

test('invalid names, schemas, oversized content and malformed stored frontmatter fail closed', async t => {
  const { store, codexHome } = await setup(t);
  for (const name of ['../escape', 'Upper', '', '-leading', 'bad_name', 'a'.repeat(65), '__proto__']) {
    await assert.rejects(store.save({ ...draft, name }), /스킬/);
    await assert.rejects(store.read(name), /스킬/);
  }
  for (const change of [{ description: '' }, { description: 'line\nbreak' }, { body: '' }, { body: '\0' }, { body: 'x'.repeat(65536) }, { unknown: true }, { expectedHash: 'not-a-hash' }]) {
    await assert.rejects(store.save({ ...draft, ...change }), /스킬|변경/);
  }
  await assert.rejects(createSitecadSkills({ codexHome: 'relative' }), /스킬/);
  await store.save(draft);
  await writeFile(join(codexHome, 'skills', draft.name, 'SKILL.md'), '---\nname: other-name\ndescription: nope\n---\nbody');
  await assert.rejects(store.read(draft.name), /스킬/);
  await assert.rejects(store.list(), /스킬/);
});

test('skill paths cannot follow symlinked homes, directories or files', async t => {
  const { root, store, codexHome } = await setup(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await mkdir(codexHome);
  await symlink(outside, join(codexHome, 'skills'), 'dir');
  await assert.rejects(store.seed(), /스킬/);
  await assert.rejects(store.save(draft), /스킬/);
  await rm(join(codexHome, 'skills'));
  await mkdir(join(codexHome, 'skills'));
  await symlink(outside, join(codexHome, 'skills', draft.name), 'dir');
  await assert.rejects(store.save(draft), /스킬/);
  await assert.rejects(store.read(draft.name), /스킬/);
  await rm(join(codexHome, 'skills', draft.name));
  await mkdir(join(codexHome, 'skills', draft.name));
  const outsideFile = join(outside, 'SKILL.md');
  await writeFile(outsideFile, 'outside');
  await symlink(outsideFile, join(codexHome, 'skills', draft.name, 'SKILL.md'));
  await assert.rejects(store.read(draft.name), /스킬/);
  await assert.rejects(store.save(draft), /스킬/);
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
  const linkedHome = join(root, 'linked-home');
  await symlink(outside, linkedHome, 'dir');
  await assert.rejects((await createSitecadSkills({ codexHome: linkedHome })).seed(), /스킬/);
});

test('concurrent edits compare the exact previous skill and cannot silently overwrite each other', async t => {
  const { store } = await setup(t);
  const initial = await store.save(draft);
  const results = await Promise.allSettled(['one', 'two'].map(body => store.save({ ...draft, body, expectedHash: initial.hash })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('owned skill removal requires an exact hash and preserves changed, built-in and companion files', async t => {
  const { store, codexHome } = await setup(t);
  await store.seed();
  const saved = await store.save(draft);
  await assert.rejects(store.remove(draft.name, '0'.repeat(64)), /변경/);
  await assert.rejects(store.remove('../escape', saved.hash), /스킬/);
  await assert.rejects(store.remove(draft.name, 'bad'), /스킬/);
  await assert.rejects(store.remove('skill-creator', saved.hash), /기본/);
  await writeFile(join(codexHome, 'skills', draft.name, 'keep.txt'), 'user file');
  await assert.rejects(store.remove(draft.name, saved.hash), /파일|변경/);
  assert.equal((await store.read(draft.name)).body, draft.body);
  await rm(join(codexHome, 'skills', draft.name, 'keep.txt'));
  await store.remove(draft.name, saved.hash);
  assert.equal((await store.list()).some(item => item.name === draft.name), false);
});
