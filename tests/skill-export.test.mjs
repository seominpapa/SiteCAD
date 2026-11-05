import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { exportSkills } from '../lib/skill-export.mjs';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';

const explanation = Object.freeze({ situation: '철근 배근도를 검토하던 상황', problem: '기호와 직경의 연결이 누락됨', changeReason: '기호별 철근 길이 합산을 추가', examplePrompt: '철근 물량을 검증해줘', expectedResult: '직경별 중량을 표로 비교' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sitecad-skill-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex-home');
  const skills = join(codexHome, 'skills');
  await mkdir(join(skills, 'quantity-custom', 'references'), { recursive: true });
  await writeFile(join(skills, 'quantity-custom', 'SKILL.md'), '---\nname: quantity-custom\ndescription: 수량 검토\n---\n# 물량');
  await writeFile(join(skills, 'quantity-custom', 'CHANGE-NOTES.md'), '# 변경 배경\n단중 검증이 필요했습니다.');
  await writeFile(join(skills, 'quantity-custom', 'references', '범례.bin'), Buffer.from([0, 255, 8, 32]));
  await writeFile(join(codexHome, 'auth.json'), 'PRIVATE-AUTH-MUST-NOT-LEAK');
  return { root, codexHome, skills, options: { codexHome, version: '0.16.3' } };
}

function readZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 8), bytes.readUInt16LE(end + 10));
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800, 'ZIP names use UTF-8');
    assert.equal(bytes.readUInt16LE(cursor + 10), 0, 'stored entries are portable');
    const checksum = bytes.readUInt32LE(cursor + 16);
    const size = bytes.readUInt32LE(cursor + 20);
    assert.equal(bytes.readUInt32LE(cursor + 24), size);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 14), checksum);
    assert.equal(bytes.readUInt16LE(local + 26), nameLength);
    assert.equal(bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
    const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    assert.equal(crc32(data), checksum);
    entries.set(name, data);
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return entries;
}

test('exports the complete nested skills folder plus Korean explanation without sibling credentials', async t => {
  const { options, codexHome } = await fixture(t);
  const { name, bytes } = await exportSkills(options, explanation);
  assert.match(name, /^SiteCAD-skills-0\.16\.3-\d{8}\.zip$/);
  assert.ok(Buffer.isBuffer(bytes));
  const entries = readZip(bytes);
  assert.ok(entries.has('skills/'));
  assert.ok(entries.has('skills/quantity-custom/SKILL.md'));
  assert.ok(entries.get('skills/quantity-custom/CHANGE-NOTES.md').toString().includes('단중 검증'));
  assert.deepEqual(entries.get('skills/quantity-custom/references/범례.bin'), Buffer.from([0, 255, 8, 32]));
  const report = entries.get('개선안 설명.md').toString('utf8');
  for (const value of Object.values(explanation)) assert.ok(report.includes(value));
  assert.match(report, /seominpapa@gmail\.com/);
  assert.match(report, /0\.16\.3/);
  assert.match(report, /기록되지|미기록|알 수 없/);
  assert.match(entries.get('개선배경/quantity-custom.md').toString('utf8'), /미기록/);
  assert.equal(bytes.includes(Buffer.from(codexHome)), false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE-AUTH-MUST-NOT-LEAK')), false);
});

test('recorded creation and update background produce companion documents without altering skills', async t => {
  const { options, codexHome } = await fixture(t);
  const store = await createSitecadSkills({ codexHome });
  const initial = await store.save({ name: 'my-workflow', description: '사용자 작업 절차', body: '# 작업\n객체를 조회합니다.', background: explanation });
  let entries = readZip((await exportSkills(options, explanation)).bytes);
  let notes = entries.get('개선배경/my-workflow.md').toString('utf8');
  assert.match(notes, /새 스킬 생성/);
  for (const value of Object.values(explanation)) assert.ok(notes.includes(value));
  assert.ok(entries.get('skills/my-workflow/SKILL.md').toString('utf8').includes('sitecad-background:v1'));
  await store.save({ name: 'my-workflow', description: '사용자 작업 절차', body: '# 작업\n직경을 검증합니다.', expectedHash: initial.hash, background: { ...explanation, changeReason: '직경 검증 추가' } });
  entries = readZip((await exportSkills(options, explanation)).bytes);
  notes = entries.get('개선배경/my-workflow.md').toString('utf8');
  assert.match(notes, /기존 스킬 수정/);
  assert.ok(notes.includes(initial.hash));
  assert.match(notes, /직경 검증 추가/);
});

test('requires explicit bounded explanation fields and trusted app metadata', async t => {
  const { options } = await fixture(t);
  for (const input of [null, [], {}, { ...explanation, unknown: 'x' }, ...Object.keys(explanation).flatMap(key => [{ ...explanation, [key]: '' }, { ...explanation, [key]: 'x'.repeat(4001) }, { ...explanation, [key]: 'bad\0value' }])]) {
    await assert.rejects(exportSkills(options, input), /설명|입력/);
  }
  for (const metadata of [{ ...options, codexHome: '.' }, { ...options, version: '../unsafe' }, { ...options, version: '' }]) await assert.rejects(exportSkills(metadata, explanation));
});

test('rejects symlinks in roots and nested resources rather than leaking their targets', async t => {
  const { options, root, codexHome, skills } = await fixture(t);
  const target = join(root, 'private.txt');
  await writeFile(target, 'SENSITIVE');
  const nested = join(skills, 'quantity-custom', 'outside.txt');
  await symlink(target, nested);
  await assert.rejects(exportSkills(options, explanation), /스킬|링크/);
  await rm(nested);
  const alternate = join(root, 'alias');
  await symlink(codexHome, alternate, 'dir');
  await assert.rejects(exportSkills({ ...options, codexHome: alternate }, explanation), /스킬|링크/);
  await rm(join(codexHome, 'skills'), { recursive: true });
  await symlink(root, join(codexHome, 'skills'), 'dir');
  await assert.rejects(exportSkills(options, explanation), /스킬|링크/);
});

test('hidden files and credential-shaped files require removal before sharing', async t => {
  const { options, skills } = await fixture(t);
  for (const name of ['.env', '.DS_Store', 'credentials.enc', 'auth.json', 'private.key']) {
    const path = join(skills, 'quantity-custom', name);
    await writeFile(path, 'private');
    await assert.rejects(exportSkills(options, explanation), /숨김|인증|비밀|스킬/);
    await rm(path);
  }
});

test('rejects unsafe Windows ZIP names, large resources, deep folders and excessive entries', async t => {
  const { options, skills } = await fixture(t);
  for (const name of process.platform === 'win32' ? [] : ['CON.txt', 'bad:name.md', 'trailing.']) {
    const path = join(skills, 'quantity-custom', name);
    await writeFile(path, 'unsafe');
    await assert.rejects(exportSkills(options, explanation), /이름|스킬/);
    await rm(path);
  }
  const large = join(skills, 'quantity-custom', 'large.bin');
  await writeFile(large, Buffer.alloc(16 * 1024 * 1024));
  await assert.rejects(exportSkills(options, explanation), /크기|용량|16MB/);
  await rm(large);
  const deep = join(skills, ...Array.from({ length: 13 }, (_, i) => `level${i}`));
  await mkdir(deep, { recursive: true });
  await assert.rejects(exportSkills(options, explanation), /깊이|단계/);
  await rm(join(skills, 'level0'), { recursive: true });
  await Promise.all(Array.from({ length: 1025 }, (_, i) => writeFile(join(skills, `entry-${i}.txt`), '')));
  await assert.rejects(exportSkills(options, explanation), /개수|1024/);
});

test('empty or unavailable skills folders fail with a safe user-facing error', async t => {
  const { options, skills } = await fixture(t);
  await rm(skills, { recursive: true });
  await assert.rejects(exportSkills(options, explanation), /스킬/);
  await mkdir(skills);
  await assert.rejects(exportSkills(options, explanation), /스킬/);
});
