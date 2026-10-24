import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSitecadPlugins } from '../lib/sitecad-plugins.mjs';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';

const SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const rawSkill = (name = 'review') => `---\nname: ${name}\ndescription: Review actual drawing objects.\n---\n# Drawing review\nRead real CAD state and preserve drawing and save guards.`;
const manifest = { name: 'cad-tools', version: '1.2.3', description: 'Drawing instructions.', skills: './skills/' };
const blobSha = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sitecad-plugins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'private');
  const skills = await createSitecadSkills({ codexHome: join(root, 'codex-home') });
  const files = options.files ?? { '.codex-plugin/plugin.json': JSON.stringify(options.manifest ?? manifest), 'skills/review/SKILL.md': rawSkill() };
  const tree = Object.entries(files).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: blobSha(text) }));
  const requests = [];
  const fetchImpl = async (value, init) => {
    const url = String(value); requests.push({ url, init });
    if (options.fetch) return options.fetch(url, init);
    if (url.includes('/commits/')) return Response.json({ sha: SHA, commit: { tree: { sha: TREE_SHA } } });
    if (url.includes('/git/trees/')) return Response.json({ sha: TREE_SHA, truncated: false, tree: options.tree ?? tree });
    const path = new URL(url).pathname.split('/').slice(4).map(decodeURIComponent).join('/');
    return Object.hasOwn(files, path) ? new Response(files[path]) : new Response('', { status: 404 });
  };
  const plugins = createSitecadPlugins({ dataDir, skills, fetchImpl });
  return { plugins, skills, dataDir, root, requests, files, tree, fetchImpl };
}

test('inspection pins source, validates actual file hashes and never installs until approved', async t => {
  const { plugins, skills, requests } = await fixture(t);
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  assert.equal(plan.name, 'cad-tools'); assert.equal(plan.version, '1.2.3'); assert.equal(plan.sourceCommit, SHA);
  assert.equal(plan.repository, 'https://github.com/example/cad-tools');
  assert.equal(plan.skills[0].name, 'plugin-cad-tools-review'); assert.match(plan.skills[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.skills[0].body, undefined); assert.equal((await skills.list()).length, 0); assert.deepEqual(await plugins.list(), []);
  assert.ok(requests.every(item => item.init.redirect === 'error' && item.init.signal));
  assert.ok(requests.filter(item => item.url.startsWith('https://raw.')).every(item => item.url.includes(`/${SHA}/`)));
  assert.ok(requests.some(item => item.url.includes('/commits/HEAD')));
  assert.ok(requests.some(item => item.url.includes(`/git/trees/${TREE_SHA}`)));
});

test('approved skills-only plugin installs isolated named skills with actual hashes and private metadata', async t => {
  const { plugins, skills, dataDir } = await fixture(t);
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  const installed = await plugins.install({ planId: plan.planId }, { approve: async proposal => {
    assert.equal(proposal.sourceCommit, SHA); assert.match(proposal.skills[0].body, /Read real CAD/);
    assert.match(proposal.warning, /지침|코드|MCP/); assert.match(proposal.manifestSha256, /^[a-f0-9]{64}$/);
    proposal.skills[0].body = 'MUTATED'; return true;
  } });
  assert.equal(installed.status, 'installed'); assert.deepEqual(installed.skills, ['plugin-cad-tools-review']);
  assert.match((await skills.read(installed.skills[0])).body, /Read real CAD/);
  const resolved = await skills.resolve('/plugin-cad-tools-review 현재 도면'); assert.equal(resolved.name, installed.skills[0]);
  assert.deepEqual(await plugins.list(), [installed]);
  const read = await plugins.read('cad-tools'); assert.match(read.skills[0].body, /Read real CAD/);
  assert.equal(read.skills[0].path, undefined); assert.match(read.skills[0].sourceSha256, /^[a-f0-9]{64}$/);
  const raw = JSON.parse(await readFile(join(dataDir, 'plugins.json'), 'utf8'));
  assert.equal(raw.version, 1); assert.equal(raw.plugins[0].skills[0].hash, (await skills.read(installed.skills[0])).hash);
  if (process.platform !== 'win32') assert.equal((await stat(join(dataDir, 'plugins.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(installed).includes(dataDir), false);
  await assert.rejects(plugins.install({ planId: plan.planId }, { approve: async () => true }), /만료|다시/);
});

test('tree URLs restrict plugin roots and arrays accept only self-contained skill directories', async t => {
  const files = {
    'packages/cad/.codex-plugin/plugin.json': JSON.stringify({ ...manifest, skills: ['./skills/review/', './skills/measure'] }),
    'packages/cad/skills/review/SKILL.md': rawSkill(), 'packages/cad/skills/measure/SKILL.md': rawSkill('measure'),
    'outside/hooks.json': '{}',
  };
  const { plugins, requests } = await fixture(t, { files });
  const plan = await plugins.inspect('https://github.com/example/cad-tools/tree/main/packages/cad');
  assert.deepEqual(plan.skills.map(item => item.name), ['plugin-cad-tools-measure', 'plugin-cad-tools-review']);
  assert.ok(requests.some(item => item.url.endsWith('/commits/main')));
  const result = await plugins.install({ planId: plan.planId }, { approve: async () => true }); assert.equal(result.skills.length, 2);
});

test('every declared skill directory must exist so missing paths cannot produce a partial installation', async t => {
  const { plugins, skills } = await fixture(t, { manifest: { ...manifest, skills: ['./skills/review', './skills/missing'] } });
  await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /경로|지침형/);
  assert.deepEqual(await skills.list(), []); assert.deepEqual(await plugins.list(), []);
});

test('compatible root and Claude manifests are accepted with the same constrained skills scope', async t => {
  for (const path of ['plugin.json', '.claude-plugin/plugin.json']) {
    const { plugins } = await fixture(t, { files: { [path]: JSON.stringify(manifest), 'skills/review/SKILL.md': rawSkill() } });
    assert.equal((await plugins.inspect('https://github.com/example/cad-tools')).name, manifest.name);
  }
});

test('standard implicit skills directory and absent version retain actual source commit without invented version', async t => {
  const { plugins } = await fixture(t, { manifest: { name: 'cad-tools', description: 'Instructions only.' } });
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  assert.equal(plan.version, null); assert.equal(plan.sourceCommit, SHA);
  const installed = await plugins.install({ planId: plan.planId }, { approve: async () => true });
  assert.equal(installed.version, null); assert.equal((await plugins.list())[0].version, null);
});

test('untrusted hosts, traversal, credentials and input schemas never trigger fetch or approval', async t => {
  const { plugins, requests } = await fixture(t);
  for (const url of ['http://github.com/example/cad-tools', 'https://user:key@github.com/example/cad-tools', 'https://github.com.evil.test/example/cad-tools', 'https://github.com/example/cad-tools?token=x', 'https://github.com/example/cad-tools#token', 'https://github.com/example/cad-tools/blob/main/plugin.json', 'https://github.com/example/cad-tools/tree/main/%2e%2e/secret', 'https://github.com/example/cad-tools/tree/main/%2froot']) await assert.rejects(plugins.inspect(url), /GitHub/);
  assert.equal(requests.length, 0);
  for (const input of [null, {}, { planId: '../secret' }, { planId: 'safe', command: '/bin/sh' }]) await assert.rejects(plugins.install(input, { approve: async () => assert.fail() }), /설치|만료/);
  await assert.rejects(plugins.read('../secret'), /이름/); await assert.rejects(plugins.remove('not-installed', { approve: async () => true }), /설치/);
  assert.throws(() => createSitecadPlugins({ dataDir: 'relative', skills: {} }), /환경/);
});

test('rejection, missing approval, cancellation and expired plans never create plugin files', async t => {
  const { plugins, skills } = await fixture(t);
  for (const approve of [undefined, async () => false, async () => 'approve']) {
    const plan = await plugins.inspect('https://github.com/example/cad-tools');
    await assert.rejects(plugins.install({ planId: plan.planId }, { approve }), /승인/);
    assert.deepEqual(await plugins.list(), []); assert.deepEqual(await skills.list(), []);
  }
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(plugins.install({ planId: plan.planId }, { approve: async () => true, signal: AbortSignal.abort() }), /취소/);
  const expired = await plugins.inspect('https://github.com/example/cad-tools');
  const now = Date.now;
  try { Date.now = () => now() + 11 * 60 * 1000; await assert.rejects(plugins.install({ planId: expired.planId }, { approve: async () => true }), /만료/); }
  finally { Date.now = now; }
  const first = await plugins.inspect('https://github.com/example/cad-tools');
  for (let count = 0; count < 21; count++) await plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(plugins.install({ planId: first.planId }, { approve: async () => true }), /만료/);
});

test('bundled MCP, apps, hooks, commands, agents and companion scripts fail closed before installation', async t => {
  for (const change of [{ mcpServers: {} }, { hooks: {} }, { apps: [] }, { commands: './commands' }, { agents: './agents' }, { scripts: {} }]) {
    const { plugins } = await fixture(t, { manifest: { ...manifest, ...change } });
    await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /지침형|지원/);
  }
  for (const extra of ['.mcp.json', 'hooks/hooks.json', '.app.json', 'agents/worker.md', 'commands/action.md', 'skills/review/references/help.md', 'skills/review/scripts/run.py']) {
    const { plugins } = await fixture(t, { files: { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/review/SKILL.md': rawSkill(), [extra]: 'untrusted' } });
    await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /지침형|지원/);
  }
});

test('manifest fields, folder references, excessive count and complex frontmatter are unsupported', async t => {
  for (const change of [{ name: '../escape' }, { skills: '../outside' }, { skills: [] }, { skills: './skills', version: {} }, { skills: './skills', name: 'x'.repeat(50) }]) {
    const { plugins } = await fixture(t, { manifest: { ...manifest, ...change } });
    await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /지원|플러그인|이름/);
  }
  for (const raw of ['no-frontmatter', '---\nname: review\ndescription: |\n  long\n---\nbody', '---\nname: review\ndescription: ok\nallowed-tools: Bash\n---\nbody', '---\nname: "bad\ndescription: ok\n---\nbody', '---\nname: review\ndescription: ok\n---\n']) {
    const { plugins } = await fixture(t, { files: { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/review/SKILL.md': raw } });
    await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /스킬|지침형/);
  }
  const files = { '.codex-plugin/plugin.json': JSON.stringify(manifest) };
  for (let index = 0; index < 9; index++) files[`skills/skill-${index}/SKILL.md`] = rawSkill(`skill-${index}`);
  const tooMany = await fixture(t, { files }); await assert.rejects(tooMany.plugins.inspect('https://github.com/example/cad-tools'), /8개/);
});

test('malformed trees, linked files, gitmodules and tampered blob bytes are rejected', async t => {
  for (const entry of [
    { path: 'skills/review/SKILL.md', mode: '120000', type: 'blob', sha: 'b'.repeat(40) },
    { path: 'vendor', mode: '160000', type: 'commit', sha: 'b'.repeat(40) },
    { path: '../escape', mode: '100644', type: 'blob', sha: 'b'.repeat(40) },
  ]) {
    const { plugins, tree } = await fixture(t);
    tree.push(entry); await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /경로|링크|서브모듈/);
  }
  const { plugins, tree } = await fixture(t); tree[1].sha = '0'.repeat(40);
  await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), /무결성/);
});

test('HTTP errors, bounded responses and broken JSON do not expose upstream errors', async t => {
  for (const fetch of [async () => { throw Error('private access token'); }, async () => new Response('private error', { status: 403 }), async () => Response.json({ sha: 'bad' }), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => new Response('bad json')]) {
    const { plugins } = await fixture(t, { fetch });
    await assert.rejects(plugins.inspect('https://github.com/example/cad-tools'), error => !/private/.test(error.message));
  }
  const tooLarge = await fixture(t, { files: { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/review/SKILL.md': rawSkill() + 'x'.repeat(65536) } });
  await assert.rejects(tooLarge.plugins.inspect('https://github.com/example/cad-tools'), /크기|64/);
});

test('an existing skill or plugin is never overwritten', async t => {
  const { plugins, skills } = await fixture(t);
  await skills.save({ name: 'plugin-cad-tools-review', description: 'Local work', body: 'Keep me' });
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(plugins.install({ planId: plan.planId }, { approve: async () => true }), /기존|충돌/);
  assert.equal((await skills.read('plugin-cad-tools-review')).body, 'Keep me'); assert.deepEqual(await plugins.list(), []);
  const clean = await fixture(t), ready = await clean.plugins.inspect('https://github.com/example/cad-tools');
  await clean.plugins.install({ planId: ready.planId }, { approve: async () => true });
  const duplicate = await clean.plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(clean.plugins.install({ planId: duplicate.planId }, { approve: async () => true }), /이미|기존/);
});

test('failed or cancelled multi-skill install rolls back only its newly created exact hashes', async t => {
  const { dataDir, skills } = await fixture(t);
  await skills.save({ name: 'existing', description: 'Existing', body: 'Keep me' });
  const files = { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/one/SKILL.md': rawSkill('one'), 'skills/two/SKILL.md': rawSkill('two') };
  const base = await fixture(t, { files });
  let saves = 0;
  const plugins = createSitecadPlugins({ dataDir, fetchImpl: async (...args) => {
    const url = args[0];
    if (String(url).includes('/commits/')) return Response.json({ sha: SHA, commit: { tree: { sha: TREE_SHA } } });
    if (String(url).includes('/git/trees/')) return Response.json({ sha: TREE_SHA, truncated: false, tree: base.tree });
    return new Response(files[new URL(url).pathname.split('/').slice(4).join('/')]);
  }, skills: { ...skills, save: async value => { if (++saves === 2) throw Error('private failure'); return skills.save(value); } } });
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(plugins.install({ planId: plan.planId }, { approve: async () => true }), error => !error.message.includes('private failure'));
  assert.deepEqual((await skills.list()).map(item => item.name), ['existing']); assert.deepEqual(await plugins.list(), []);
  assert.ok((await readdir(dataDir)).every(name => !name.endsWith('.tmp')));
});

test('status identifies edited or missing skills and removal requires exact reviewed hashes', async t => {
  const { plugins, skills } = await fixture(t);
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  const installed = await plugins.install({ planId: plan.planId }, { approve: async () => true });
  const current = await skills.read(installed.skills[0]);
  await skills.save({ name: current.name, description: current.description, body: 'User changed', expectedHash: current.hash });
  assert.equal((await plugins.list())[0].status, 'modified'); assert.equal((await plugins.read('cad-tools')).status, 'modified');
  await assert.rejects(plugins.remove('cad-tools', { approve: async () => true }), /변경/);
  assert.equal((await skills.read(current.name)).body, 'User changed');
  const changed = await skills.read(current.name); await skills.remove(current.name, changed.hash);
  assert.equal((await plugins.list())[0].status, 'unavailable');
});

test('approved removal deletes only plugin-owned skills and metadata', async t => {
  const { plugins, skills } = await fixture(t);
  await skills.save({ name: 'existing', description: 'Existing', body: 'Keep me' });
  const plan = await plugins.inspect('https://github.com/example/cad-tools'); await plugins.install({ planId: plan.planId }, { approve: async () => true });
  await assert.rejects(plugins.remove('cad-tools', { approve: async () => false }), /승인/);
  const removed = await plugins.remove('cad-tools', { approve: async proposal => { assert.deepEqual(proposal.skills.map(item => item.name), ['plugin-cad-tools-review']); return true; } });
  assert.equal(removed.removed, true); assert.deepEqual(await plugins.list(), []); assert.deepEqual((await skills.list()).map(item => item.name), ['existing']);
});

test('linked private roots and metadata files are rejected without touching their targets', async t => {
  const { plugins, dataDir, root } = await fixture(t);
  const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, dataDir, 'dir');
  await assert.rejects(plugins.list(), /저장|경로/);
  await rm(dataDir); await mkdir(dataDir); const secret = join(outside, 'secret'); await writeFile(secret, 'keep'); await symlink(secret, join(dataDir, 'plugins.json'));
  await assert.rejects(plugins.list(), /저장|경로/); assert.equal(await readFile(secret, 'utf8'), 'keep');
});

test('cancellation between writes removes only new skills and leaves the existing store intact', async t => {
  const files = { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/one/SKILL.md': rawSkill('one'), 'skills/two/SKILL.md': rawSkill('two') };
  const base = await fixture(t, { files });
  const controller = new AbortController();
  const plugins = createSitecadPlugins({ dataDir: base.dataDir, fetchImpl: base.fetchImpl, skills: { ...base.skills,
    async save(input) { const saved = await base.skills.save(input); controller.abort(); return saved; },
  } });
  const plan = await plugins.inspect('https://github.com/example/cad-tools');
  await assert.rejects(plugins.install({ planId: plan.planId }, { approve: async () => true, signal: controller.signal }), /취소/);
  assert.deepEqual(await base.skills.list(), []); assert.deepEqual(await plugins.list(), []);
});

test('cancelled multi-skill removal restores the exact prior plugin skills and metadata', async t => {
  const files = { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/one/SKILL.md': rawSkill('one'), 'skills/two/SKILL.md': rawSkill('two') };
  const base = await fixture(t, { files });
  const plan = await base.plugins.inspect('https://github.com/example/cad-tools');
  const installed = await base.plugins.install({ planId: plan.planId }, { approve: async () => true });
  const controller = new AbortController();
  const plugins = createSitecadPlugins({ dataDir: base.dataDir, skills: { ...base.skills,
    async remove(name, expectedHash) { const result = await base.skills.remove(name, expectedHash); controller.abort(); return result; },
  } });
  await assert.rejects(plugins.remove(installed.name, { approve: async () => true, signal: controller.signal }), /취소/);
  assert.deepEqual(await base.plugins.list(), [installed]); assert.equal((await base.skills.list()).length, 2);
});

test('interrupted response streams are sanitized and unsupported companion references are explicit', async t => {
  const broken = await fixture(t, { fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('private token')); } })) });
  await assert.rejects(broken.plugins.inspect('https://github.com/example/cad-tools'), error => error.sitecadSafe && !error.message.includes('private token'));
  for (const body of ['Read [the helper](helper.md).', 'Read ./guide.md', 'Read references/guide.md']) {
    const sample = await fixture(t, { files: { '.codex-plugin/plugin.json': JSON.stringify(manifest), 'skills/review/SKILL.md': `---\nname: review\ndescription: Review.\n---\n${body}` } });
    await assert.rejects(sample.plugins.inspect('https://github.com/example/cad-tools'), /지침형/);
  }
});

test('private metadata failures do not retain newly installed skills or overwrite symlink targets', async t => {
  const base = await fixture(t);
  const plan = await base.plugins.inspect('https://github.com/example/cad-tools');
  const outside = join(base.root, 'outside'); await writeFile(outside, 'keep');
  await assert.rejects(base.plugins.install({ planId: plan.planId }, { approve: async () => { await symlink(outside, join(base.dataDir, 'plugins.json')); return true; } }), /저장 경로/);
  assert.deepEqual(await base.skills.list(), []); assert.equal(await readFile(outside, 'utf8'), 'keep');
  await rm(join(base.dataDir, 'plugins.json')); await writeFile(join(base.dataDir, 'plugins.json'), '{broken');
  await assert.rejects(base.plugins.list(), /JSON/);
  await writeFile(join(base.dataDir, 'plugins.json'), JSON.stringify({ version: 2, plugins: [] }));
  await assert.rejects(base.plugins.list(), /저장 정보/);
});
