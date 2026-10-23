import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLocalWeb, sourceEntries } from '../scripts/build-local-web.mjs';

const execute = promisify(execFile);
const project = new URL('../', import.meta.url);

test('release dependency lock excludes vulnerable Zod versions from REA and MCP', async () => {
  const lock = JSON.parse(await readFile(new URL('package-lock.json', project), 'utf8'));
  const schemas = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/zod'));
  assert.ok(schemas.length > 0);
  for (const [, value] of schemas) assert.equal(value.version, '4.6.6');
});

test('macOS bootstrap pins verified private Node and retains the full local runtime', async () => {
  const bootstrap = await readFile(new URL('scripts/bootstrap-local-web.sh', project), 'utf8');
  await execute('/bin/bash', ['-n', new URL('scripts/bootstrap-local-web.sh', project).pathname]);
  assert.match(bootstrap, /NODE_VERSION="24\.22\.1"/);
  assert.match(bootstrap, /89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7/);
  assert.match(bootstrap, /d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035/);
  assert.match(bootstrap, /ci --omit=dev/);
  assert.doesNotMatch(bootstrap, /electron/i);
  assert.match(bootstrap, /install-codex\.mjs/);
  assert.match(bootstrap, /runtime\/manifest\.json/);
  assert.doesNotMatch(bootstrap, /desktop\/runtime/);
  assert.match(bootstrap, /exec "\$NODE_ROOT\/bin\/node" "\$ROOT\/local-web\.mjs"/);
  assert.match(bootstrap, /setup\.lock/);
  assert.match(bootstrap, /trap cleanup EXIT/);
  assert.doesNotMatch(bootstrap, /sudo|brew install|npm install -g/);
  const command = await readFile(new URL('Start SiteCAD.command', project), 'utf8');
  assert.match(command, /bootstrap-local-web\.sh/);
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'sitecad-install-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source with spaces');
  for (const name of sourceEntries) {
    const directory = ['lib', 'public', 'desktop/licenses', 'vendor/editor'].includes(name);
    await mkdir(directory ? join(sourceRoot, name) : dirname(join(sourceRoot, name)), { recursive: true });
    if (directory) await writeFile(join(sourceRoot, name, 'included.txt'), name);
    else await writeFile(join(sourceRoot, name), name === 'package.json' ? JSON.stringify({ version: '0.11.0' }) : 'fixture');
  }
  await writeFile(join(sourceRoot, 'vendor/editor/manifest.local.json'), JSON.stringify({ files: [] }));
  const fixturePath = join(base, 'original.dwg');
  await writeFile(fixturePath, 'AC1032 test drawing');
  return { base, sourceRoot, fixturePath };
}

test('release ZIP contains standalone drawing and allowlisted source, never private project state', async t => {
  const { base, sourceRoot, fixturePath } = await fixture(t);
  for (const name of ['.env', 'credentials.enc', 'private-note.txt', 'lib/.env', 'lib/.env.local', 'public/credentials.enc']) await writeFile(join(sourceRoot, name), 'secret');
  for (const name of ['node_modules', 'test-results', '.runtime', 'desktop/runtime']) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, 'secret.txt'), 'secret');
  }
  const archive = await buildLocalWeb({ sourceRoot, fixturePath, outputDirectory: join(base, 'release output') });
  const { stdout } = await execute('/usr/bin/unzip', ['-Z1', archive]);
  assert.match(stdout, /SiteCAD\/Start SiteCAD\.command/);
  assert.match(stdout, /SiteCAD\/fixtures\/retaining-wall\.dwg/);
  assert.match(stdout, /SiteCAD\/local-web\.mjs/);
  assert.doesNotMatch(stdout, /SiteCAD\/desktop\/main\.mjs/);
  assert.doesNotMatch(stdout, /secret|credentials|\.env|node_modules|test-results|desktop\/runtime\//);
  const extracted = join(base, 'extracted');
  await mkdir(extracted);
  await execute('/usr/bin/unzip', ['-q', archive, '-d', extracted]);
  assert.equal(await readFile(join(extracted, 'SiteCAD/fixtures/retaining-wall.dwg'), 'utf8'), 'AC1032 test drawing');
  assert.ok((await stat(join(extracted, 'SiteCAD/Start SiteCAD.command'))).mode & 0o111);
  assert.deepEqual(await readdir(join(extracted, 'SiteCAD/fixtures')), ['retaining-wall.dwg']);
});

test('release build rejects linked private files inside otherwise public source', async t => {
  const { base, sourceRoot, fixturePath } = await fixture(t);
  await writeFile(join(base, 'private'), 'secret');
  await symlink(join(base, 'private'), join(sourceRoot, 'public/linked-secret'));
  await assert.rejects(buildLocalWeb({ sourceRoot, fixturePath, outputDirectory: join(base, 'dist') }), /symbolic link/);
});

async function bootstrapFixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'sitecad-bootstrap-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'SiteCAD with spaces');
  const runtime = join(root, '.runtime/local-web');
  const arch = process.arch;
  const bin = join(runtime, `node-v24.22.1-darwin-${arch}`, 'bin');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, 'scripts/bootstrap-local-web.sh'), await readFile(new URL('scripts/bootstrap-local-web.sh', project)));
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(bin, 'node'), '#!/bin/bash\nprintf "v24.22.1\\n"\n', { mode: 0o755 });
  await writeFile(join(bin, 'npm'), '#!/bin/bash\nprintf "%s\\n" "$*" > "$PWD/npm-attempt.txt"\nexit 39\n', { mode: 0o755 });
  return { root, runtime, script: join(root, 'scripts/bootstrap-local-web.sh') };
}

test('concurrent setup does not replace a live installation lock', { skip: process.platform !== 'darwin' }, async t => {
  const { runtime, script } = await bootstrapFixture(t);
  await mkdir(join(runtime, 'setup.lock'));
  await writeFile(join(runtime, 'setup.lock/pid'), String(process.pid));
  await assert.rejects(execute('/bin/bash', [script]), error => {
    assert.match(error.stderr, /다른 SiteCAD 설치/);
    return true;
  });
  assert.equal(await readFile(join(runtime, 'setup.lock/pid'), 'utf8'), String(process.pid));
});

test('stale lock is preserved and a failed installation cleans only its own lock generation', { skip: process.platform !== 'darwin' }, async t => {
  const { root, runtime, script } = await bootstrapFixture(t);
  await mkdir(join(runtime, 'setup.lock'));
  await writeFile(join(runtime, 'setup.lock/pid'), '2147483647');
  await writeFile(join(runtime, 'dependencies.ready'), 'old lock hash');
  await assert.rejects(execute('/bin/bash', [script]), error => error.code === 39);
  assert.match(await readFile(join(root, 'npm-attempt.txt'), 'utf8'), /^ci --omit=dev/);
  await assert.rejects(stat(join(runtime, 'dependencies.ready')), { code: 'ENOENT' });
  assert.equal(await readFile(join(runtime, 'setup.lock/pid'), 'utf8'), '2147483647');
  await assert.rejects(stat(join(runtime, 'setup-1.lock')), { code: 'ENOENT' });
  await assert.rejects(execute('/bin/bash', [script]), error => error.code === 39);
});

test('release build rejects invalid version paths and linked drawing fixtures', async t => {
  const { base, sourceRoot, fixturePath } = await fixture(t);
  const outputDirectory = join(base, 'dist');
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ version: '../private' }));
  await assert.rejects(buildLocalWeb({ sourceRoot, fixturePath, outputDirectory }), /Invalid SiteCAD release version/);
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ version: '0.11.0' }));
  const linked = join(base, 'linked.dwg');
  await symlink(fixturePath, linked);
  await assert.rejects(buildLocalWeb({ sourceRoot, fixturePath: linked, outputDirectory }), /symbolic link/);
});

test('release can rebuild using its bundled fixture without the parent repository', async t => {
  const { base, sourceRoot } = await fixture(t);
  await mkdir(join(sourceRoot, 'fixtures'));
  await writeFile(join(sourceRoot, 'fixtures/retaining-wall.dwg'), 'bundled drawing');
  const archive = await buildLocalWeb({ sourceRoot, outputDirectory: join(base, 'dist') });
  const { stdout } = await execute('/usr/bin/unzip', ['-p', archive, 'SiteCAD/fixtures/retaining-wall.dwg']);
  assert.equal(stdout, 'bundled drawing');
});

test('npm success without an installed dependency lock does not mark installation ready', { skip: process.platform !== 'darwin' }, async t => {
  const { root, runtime, script } = await bootstrapFixture(t);
  await writeFile(join(runtime, `node-v24.22.1-darwin-${process.arch}`, 'bin/npm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  await assert.rejects(execute('/bin/bash', [script]), error => {
    assert.match(error.stderr, /의존성 설치를 완료하지 못했습니다/);
    return true;
  });
  await assert.rejects(stat(join(runtime, 'dependencies.ready')), { code: 'ENOENT' });
});

test('successful production install launches private Node and the second launch reuses dependencies', { skip: process.platform !== 'darwin' }, async t => {
  const { root, runtime, script } = await bootstrapFixture(t);
  const bin = join(runtime, `node-v24.22.1-darwin-${process.arch}`, 'bin');
  await mkdir(join(root, 'vendor/editor'), { recursive: true });
  await writeFile(join(root, 'vendor/editor/manifest.local.json'), '{}');
  await writeFile(join(root, 'local-web.mjs'), '// launch fixture');
  await writeFile(join(bin, 'npm'), '#!/bin/bash\nmkdir -p "$PWD/node_modules"\nprintf "installed\\n" >> "$PWD/npm-attempt.txt"\nprintf "{}" > "$PWD/node_modules/.package-lock.json"\n', { mode: 0o755 });
  await writeFile(join(bin, 'node'), '#!/bin/bash\nif [ "$1" = --version ]; then printf "v24.22.1\\n"; elif [ "$1" = --input-type=module ]; then cat > /dev/null; else printf "%s\\n" "$*" >> "$PWD/launched.txt"; fi\n', { mode: 0o755 });
  await execute('/bin/bash', [script]);
  await execute('/bin/bash', [script]);
  assert.equal(await readFile(join(root, 'npm-attempt.txt'), 'utf8'), 'installed\n');
  assert.equal(await readFile(join(root, 'launched.txt'), 'utf8'), `${root}/local-web.mjs\n${root}/local-web.mjs\n`);
  assert.match(await readFile(join(runtime, 'dependencies.ready'), 'utf8'), /-node-only\n$/);
  await assert.rejects(stat(join(runtime, 'setup.lock')), { code: 'ENOENT' });
});


test('two stale-lock recoverers cannot remove the new owner lock or install simultaneously', { skip: process.platform !== 'darwin' }, async t => {
  const { root, runtime, script } = await bootstrapFixture(t);
  await mkdir(join(runtime, 'setup.lock'));
  await writeFile(join(runtime, 'setup.lock/pid'), '2147483647');
  await writeFile(join(runtime, `node-v24.22.1-darwin-${process.arch}`, 'bin/npm'), '#!/bin/bash\nprintf "installed\\n" >> "$PWD/npm-attempt.txt"\nsleep 2\nexit 39\n', { mode: 0o755 });
  const outcomes = await Promise.allSettled([execute('/bin/bash', [script]), execute('/bin/bash', [script])]);
  assert.deepEqual(outcomes.map(result => result.reason.code).sort((a, b) => a - b), [1, 39]);
  assert.match(outcomes.find(result => result.reason.code === 1).reason.stderr, /다른 SiteCAD 설치/);
  assert.equal(await readFile(join(root, 'npm-attempt.txt'), 'utf8'), 'installed\n');
  assert.equal(await readFile(join(runtime, 'setup.lock/pid'), 'utf8'), '2147483647');
  await assert.rejects(stat(join(runtime, 'setup-1.lock')), { code: 'ENOENT' });
});
