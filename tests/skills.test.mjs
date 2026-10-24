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

test('default creator, finder and installer seed only into private Codex home and preserve existing files', async t => {
  const { store, codexHome } = await setup(t);
  await store.seed();
  const skills = await store.list();
  assert.deepEqual(skills.map(skill => skill.name), ['skill-creator', 'skill-finder', 'skill-installer']);
  for (const skill of skills) {
    assert.equal(skill.builtin, true);
    assert.equal(skill.path, join(codexHome, 'skills', skill.name, 'SKILL.md'));
    assert.match(skill.hash, /^[a-f0-9]{64}$/);
    assert.equal((await stat(skill.path)).mode & 0o777, 0o600);
    assert.ok((await store.read(skill.name)).body.includes('sitecad_'));
  }
  const changed = (await readFile(skills[0].path, 'utf8')).replace('# SiteCAD', '# Changed SiteCAD');
  await writeFile(skills[0].path, changed);
  await store.seed();
  assert.equal(await readFile(skills[0].path, 'utf8'), changed);
  await assert.rejects(store.save({ ...draft, name: 'skill-creator' }), /기본 스킬/);
});

test('skill creation is private, discoverable, immutable to callers and hash guarded on update', async t => {
  const { store, codexHome } = await setup(t);
  const saved = await store.save(draft);
  assert.equal(saved.name, draft.name);
  assert.equal(saved.builtin, false);
  assert.equal(saved.path, join(codexHome, 'skills', draft.name, 'SKILL.md'));
  const raw = await readFile(saved.path, 'utf8');
  assert.ok(raw.startsWith('---\nname: "drawing-review"\ndescription: '));
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
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
