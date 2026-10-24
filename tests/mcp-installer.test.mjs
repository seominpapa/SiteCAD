import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpInstaller } from '../lib/mcp-installer.mjs';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const source = { name: '@example/cad-mcp', version: '0.0.0-dev', bin: { 'cad-mcp': 'dist/server.js' } };
const published = { ...source, version: '1.2.3', repository: { url: 'git+https://github.com/example/cad-mcp.git' }, dist: { integrity, tarball: 'https://registry.npmjs.org/@example/cad-mcp/-/cad-mcp-1.2.3.tgz' } };

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-installer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'private');
  const nodePath = join(directory, 'runtime', 'bin', 'node');
  const npm = join(directory, 'runtime', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(dirname(nodePath), { recursive: true });
  await mkdir(dirname(npm), { recursive: true });
  if (options.realProcess) await symlink(process.execPath, nodePath); else await writeFile(nodePath, 'node');
  await writeFile(npm, options.npmScript ?? 'npm');
  const requests = []; const runs = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (options.fetchResponse) return options.fetchResponse(String(url), init);
    if (String(url).includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
    if (String(url).includes('/contents/')) return Response.json(options.source ?? source);
    if (String(url).startsWith('https://registry.npmjs.org/')) return Response.json(options.published ?? published);
    return Response.json({ default_branch: 'main' });
  };
  const runProcess = async (command, args, settings) => {
    runs.push({ command, args, settings });
    if (options.run) return options.run(command, args, settings);
    const packageDir = join(settings.cwd, 'node_modules', '@example', 'cad-mcp');
    await mkdir(join(packageDir, 'dist'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(published));
    await writeFile(join(packageDir, 'dist', 'server.js'), 'console.log("server");');
    await writeFile(join(settings.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@example/cad-mcp': { version: published.version, integrity } } }));
  };
  return { dataDir, directory, nodePath, requests, runs, installer: createMcpInstaller({ dataDir, nodePath, fetchImpl, runProcess: options.realProcess ? undefined : runProcess, ...options.config }) };
}

test('inspection pins public repository commit and published Node package without installing', async t => {
  const { installer, runs, requests } = await setup(t);
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  assert.equal(plan.repository, 'https://github.com/example/cad-mcp');
  assert.equal(plan.sourceCommit, 'a'.repeat(40));
  assert.equal(plan.packageName, source.name); assert.equal(plan.version, '1.2.3');
  assert.equal(plan.integrity, integrity); assert.equal(plan.bin, 'dist/server.js');
  assert.equal(plan.name, 'cad-mcp'); assert.equal(runs.length, 0);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(item => item.init.redirect === 'error' && item.init.signal));
  assert.ok(requests.filter(item => item.url.startsWith('https://api.github.com/')).every(item => item.init.headers.Accept === 'application/vnd.github.raw+json'));
  assert.equal(requests.find(item => item.url.startsWith('https://registry.npmjs.org/')).init.headers.Accept, 'application/json');
});

test('published Node bin paths may have harmless leading relative prefixes', async t => {
  const { installer } = await setup(t, { published: { ...published, bin: { 'cad-mcp': './dist/server.js' } } });
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  assert.equal(plan.bin, 'dist/server.js');
  const result = await installer.install({ planId: plan.planId, name: 'relative' }, { approve: async () => true });
  assert.ok(result.config.args[0].endsWith('/dist/server.js'));
});

test('GitHub tree URL chooses only its package path and immutable commit for contents', async t => {
  const { installer, requests } = await setup(t);
  await installer.inspect('https://github.com/example/cad-mcp/tree/main/packages/server');
  assert.ok(requests.some(item => item.url.endsWith('/contents/packages/server/package.json?ref=' + 'a'.repeat(40))));
});

test('invalid hosts, credentials, queries, traversal and source links never perform a fetch', async t => {
  const { installer, requests } = await setup(t);
  for (const value of ['http://github.com/example/cad-mcp', 'https://github.com.evil.test/example/cad-mcp', 'https://user:password@github.com/example/cad-mcp', 'https://github.com/example/cad-mcp?token=secret', 'https://github.com/example/cad-mcp/blob/main/package.json', 'https://github.com/example/cad-mcp/tree/main/%2e%2e/private', 'https://github.com/example/cad-mcp#token', 'https://github.com/example/cad-mcp/tree/main/%2fprivate']) await assert.rejects(installer.inspect(value), /GitHub/);
  assert.equal(requests.length, 0);
});

test('source-only packages and packages published by another repository are unsupported', async t => {
  const missing = await setup(t, { source: { name: 'source-only' } });
  await assert.rejects(missing.installer.inspect('https://github.com/example/cad-mcp'), /Node|지원/);
  const other = await setup(t, { published: { ...published, repository: 'https://github.com/attacker/another' } });
  await assert.rejects(other.installer.inspect('https://github.com/example/cad-mcp'), /저장소/);
  assert.equal(other.runs.length, 0);
});

test('inspection rejects ambiguous bins, unsafe paths, missing integrity and external tarballs', async t => {
  const manifests = [
    { ...published, bin: { one: 'one.js', two: 'two.js' } },
    { ...published, bin: { 'cad-mcp': '../outside.js' } },
    { ...published, bin: { 'cad-mcp': '/outside.js' } },
    { ...published, dist: { ...published.dist, integrity: 'sha1-bad' } },
    { ...published, dist: { ...published.dist, tarball: 'https://evil.test/thing.tgz' } },
  ];
  for (const manifest of manifests) {
    const { installer } = await setup(t, { published: manifest });
    await assert.rejects(installer.inspect('https://github.com/example/cad-mcp'), /패키지|실행|무결성/);
  }
});

test('approval is exact, required and single-use; denial and cancellation never install', async t => {
  const { installer, runs } = await setup(t);
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: plan.planId, name: 'my-cad' }), /승인/);
  const next = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: next.planId, name: 'my-cad' }, { approve: async proposal => { assert.equal(proposal.packageName, source.name); assert.equal(proposal.name, 'my-cad'); assert.match(proposal.warning, /파일|권한/); return false; } }), /승인/);
  const cancelled = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: cancelled.planId, name: 'my-cad' }, { approve: async () => true, signal: AbortSignal.abort() }), /취소/);
  assert.equal(runs.length, 0);
});

test('installation uses private HOME/cache, script-free pinned npm package and verified Node bin', async t => {
  const { installer, runs, dataDir, nodePath } = await setup(t);
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  let approved;
  const result = await installer.install({ planId: plan.planId, name: 'my-cad', args: ['--readonly', 'local-drawing'] }, { approve: async proposal => { approved = structuredClone(proposal); proposal.version = 'attacker'; return true; } });
  assert.equal(approved.version, '1.2.3');
  assert.equal(result.config.command, nodePath); assert.equal(result.config.name, 'my-cad');
  assert.equal(result.config.transport, 'stdio'); assert.equal(result.config.enabled, true);
  assert.ok(result.config.args[0].startsWith(join(dataDir, 'managed-mcp')));
  assert.deepEqual(result.config.args.slice(1), ['--readonly', 'local-drawing']);
  assert.equal(result.installation.status, 'installed_pending_connection');
  assert.equal(result.installation.version, '1.2.3');
  const run = runs[0]; assert.equal(run.command, nodePath);
  assert.ok(run.args.includes('--ignore-scripts')); assert.ok(run.args.includes('--no-bin-links'));
  assert.ok(run.args.includes('@example/cad-mcp@1.2.3'));
  assert.equal(run.settings.env.HOME, run.settings.cwd);
  assert.equal(run.settings.env.CODEX_HOME, undefined); assert.equal(run.settings.env.ACCESS_TOKEN, undefined);
  assert.equal(run.settings.env.NODE_OPTIONS, undefined);
  assert.ok(run.args.some(arg => arg.startsWith('--cache=' + run.settings.cwd)));
  assert.equal((await lstat(result.installation.path)).mode & 0o777, 0o700);
  await assert.rejects(installer.install({ planId: plan.planId, name: 'my-cad' }, { approve: async () => true }), /다시|만료/);
  await installer.remove(result.installation.id);
  assert.deepEqual(await readdir(join(dataDir, 'managed-mcp')), []);
});

test('unsafe names, secret arguments and arbitrary install fields fail before approval', async t => {
  const { installer, runs } = await setup(t);
  for (const input of [{ name: '../escape' }, { name: 'sitecad' }, { name: 'safe', args: ['--api-key=secret'] }, { name: 'safe', args: ['sk-private'] }, { name: 'safe', args: ['line\nbreak'] }, { name: 'safe', command: '/bin/sh' }]) {
    const plan = await installer.inspect('https://github.com/example/cad-mcp');
    await assert.rejects(installer.install({ planId: plan.planId, ...input }, { approve: async () => assert.fail('must not approve') }), /설치|키|인수/);
  }
  assert.equal(runs.length, 0);
});

test('failed package process and mismatched lock integrity clean only the new installation', async t => {
  for (const run of [async () => { throw Error('npm failure with private token'); }, async (_command, _args, settings) => { await writeFile(join(settings.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@example/cad-mcp': { version: '1.2.3', integrity: 'changed' } } })); }]) {
    const { installer, dataDir } = await setup(t, { run });
    const plan = await installer.inspect('https://github.com/example/cad-mcp');
    await assert.rejects(installer.install({ planId: plan.planId, name: 'safe' }, { approve: async () => true }), error => !error.message.includes('private token'));
    assert.deepEqual(await readdir(join(dataDir, 'managed-mcp')), []);
  }
});

test('symlink package entry and private install root are rejected without starting a server', async t => {
  const { installer, directory, dataDir, runs } = await setup(t, { run: async (_command, _args, settings) => {
    const packageDir = join(settings.cwd, 'node_modules', '@example', 'cad-mcp');
    await mkdir(join(packageDir, 'dist'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(published));
    await symlink(join(directory, 'outside.js'), join(packageDir, 'dist', 'server.js'));
    await writeFile(join(settings.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@example/cad-mcp': { version: '1.2.3', integrity } } }));
  } });
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: plan.planId, name: 'safe' }, { approve: async () => true }), /실행|설치/);
  await rm(join(dataDir, 'managed-mcp'), { recursive: true });
  await symlink(directory, join(dataDir, 'managed-mcp'));
  const next = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: next.planId, name: 'safe' }, { approve: async () => true }), /설치/);
  assert.equal(runs.length, 1);
  await assert.rejects(installer.remove('../outside'), /설치/);
});

test('bounded metadata responses and HTTP errors are sanitized', async t => {
  for (const fetchResponse of [async () => new Response('x'.repeat(1024 * 1024 + 1)), async () => new Response('private error text', { status: 404 }), async () => Response.json(null), async () => { throw Error('private network details'); }]) {
    const { installer } = await setup(t, { fetchResponse });
    await assert.rejects(installer.inspect('https://github.com/example/cad-mcp'), error => !error.message.includes('private error text'));
  }
});

test('plans expire and the pending plan count remains bounded', async t => {
  const { installer, runs } = await setup(t);
  const old = await installer.inspect('https://github.com/example/cad-mcp');
  const now = Date.now;
  try {
    Date.now = () => now() + 11 * 60 * 1000;
    await assert.rejects(installer.install({ planId: old.planId, name: 'old' }, { approve: async () => true }), /만료/);
  } finally { Date.now = now; }
  for (let i = 0; i < 21; i++) await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: old.planId, name: 'old' }, { approve: async () => true }), /만료/);
  assert.equal(runs.length, 0);
});

test('missing packaged npm reports required distribution and never runs a shell fallback', async t => {
  const { installer, directory, runs } = await setup(t);
  await rm(join(directory, 'runtime', 'lib'), { recursive: true });
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  await assert.rejects(installer.install({ planId: plan.planId, name: 'missing' }, { approve: async () => true }), /npm.*원클릭/);
  assert.equal(runs.length, 0);
});

test('Homebrew adjacent npm symlink resolves to npm-cli.js without PATH or shell lookup', async t => {
  const { installer, directory, runs } = await setup(t);
  await rm(join(directory, 'runtime', 'lib'), { recursive: true });
  const target = join(directory, 'runtime', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'trusted npm CLI');
  await symlink('../libexec/lib/node_modules/npm/bin/npm-cli.js', join(directory, 'runtime', 'bin', 'npm'));
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  await installer.install({ planId: plan.planId, name: 'homebrew' }, { approve: async () => true });
  assert.equal(runs[0].args[0], await realpath(target));
});

test('real Node subprocess runs without shell and reports install, failure and cancellation safely', async t => {
  const npmScript = `const fs=require('node:fs');const path=require('node:path');const cwd=process.cwd();const pkg=path.join(cwd,'node_modules','@example','cad-mcp');fs.mkdirSync(path.join(pkg,'dist'),{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),${JSON.stringify(JSON.stringify(published))});fs.writeFileSync(path.join(pkg,'dist','server.js'),'');fs.writeFileSync(path.join(cwd,'package-lock.json'),JSON.stringify({packages:{'node_modules/@example/cad-mcp':{version:'1.2.3',integrity:${JSON.stringify(integrity)}}}}));fs.writeFileSync(path.join(cwd,'execution.json'),JSON.stringify({argv:process.argv,env:process.env}));`;
  const { installer } = await setup(t, { realProcess: true, npmScript });
  const plan = await installer.inspect('https://github.com/example/cad-mcp');
  const result = await installer.install({ planId: plan.planId, name: 'actual' }, { approve: async () => true });
  const execution = JSON.parse(await readFile(join(result.installation.path, 'execution.json'), 'utf8'));
  assert.equal(execution.env.HOME, result.installation.path); assert.equal(execution.env.CODEX_HOME, undefined);
  assert.ok(execution.argv.includes('@example/cad-mcp@1.2.3'));
  for (const npmScript of ['process.stderr.write("private-failure");process.exit(1);', 'process.stdout.write("x".repeat(1024*1024+1));setTimeout(()=>{},10000);']) {
    const failed = await setup(t, { realProcess: true, npmScript });
    const failedPlan = await failed.installer.inspect('https://github.com/example/cad-mcp');
    await assert.rejects(failed.installer.install({ planId: failedPlan.planId, name: 'failed' }, { approve: async () => true }), error => !error.message.includes('private-failure'));
  }
  const abort = new AbortController();
  const cancelled = await setup(t, { realProcess: true, npmScript: 'setTimeout(()=>{},10000);' });
  const cancelPlan = await cancelled.installer.inspect('https://github.com/example/cad-mcp');
  const pending = cancelled.installer.install({ planId: cancelPlan.planId, name: 'cancelled' }, { approve: async () => true, signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(pending, /취소/);
});
