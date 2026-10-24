import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { desktopPaths, isAllowedAuthUrl, createSecureStore, installBundledCodex } from '../desktop/runtime.mjs';
import { CODEX_VERSION, codexTarget, extractCodexArchive, installCodex, windowsCodexFiles } from '../scripts/install-codex.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('desktop paths isolate runtime, workspace and Codex settings under app data', () => {
  const directory = join(tmpdir(), 'SiteCAD');
  const paths = desktopPaths(directory);
  for (const value of Object.values(paths)) assert.equal(dirname(value), directory);
  assert.equal(paths.codexHome, join(directory, 'codex-home'));
  assert.throws(() => desktopPaths('relative'));
});

test('only exact OpenAI browser authentication hosts and HTTPS are allowed', () => {
  assert.equal(isAllowedAuthUrl('https://auth.openai.com/oauth/authorize?state=abc'), true);
  for (const url of ['javascript:alert(1)', 'http://auth.openai.com/', 'https://auth.openai.com.evil.test/', 'https://user:secret@auth.openai.com/', 'https://evil.test/', 'https://auth.openai.com:444/']) assert.equal(isAllowedAuthUrl(url), false);
});

test('secrets are encrypted, private, round trip, and remove cleanly', async t => {
  const directory = await temp(t);
  const file = join(directory, 'credentials');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from([...text].reverse().join('')), decryptString: bytes => [...bytes.toString()].reverse().join('') };
  const store = createSecureStore({ file, safeStorage });
  assert.equal(await store.read(), null);
  const value = { access_token: 'private-token' };
  await store.write(value);
  assert.deepEqual(await store.read(), value);
  assert.equal((await readFile(file)).includes('private-token'), false);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.remove();
  assert.equal(await store.read(), null);
});

test('unavailable keychain and malformed encrypted files fail closed', async t => {
  const directory = await temp(t);
  const file = join(directory, 'credentials');
  const store = createSecureStore({ file, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(store.write({ secret: true }), /Keychain/);
  await writeFile(file, 'corrupted');
  await assert.rejects(store.read(), /Keychain/);
});

test('Codex targets are pinned to official architecture-specific published hashes', () => {
  assert.match(CODEX_VERSION, /^\d+\.\d+\.\d+$/);
  for (const arch of ['arm64', 'x64']) {
    const target = codexTarget(arch, 'darwin');
    assert.match(target.url, /^https:\/\/github.com\/openai\/codex\/releases\/download\/rust-v/);
    assert.match(target.sha256, /^[a-f0-9]{64}$/);
    assert.ok(target.member.endsWith('-apple-darwin'));
  }
  assert.throws(() => codexTarget('linux'), /architecture/);
});

test('archive integrity is checked before extraction and destination is atomically replaced', async t => {
  const directory = await temp(t);
  const member = 'codex-aarch64-apple-darwin';
  const archive = join(directory, 'codex.tar.gz');
  const destination = join(directory, 'installed-codex');
  await writeFile(join(directory, member), 'native-binary');
  execFileSync('tar', ['-czf', archive, '-C', directory, member]);
  await writeFile(destination, 'old-valid-binary');
  await assert.rejects(extractCodexArchive({ archive, destination, member, sha256: '0'.repeat(64) }), /integrity/);
  assert.equal(await readFile(destination, 'utf8'), 'old-valid-binary');
  await extractCodexArchive({ archive, destination, member, sha256: hash(await readFile(archive)) });
  assert.equal(await readFile(destination, 'utf8'), 'native-binary');
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o755);
});

test('archives with additional members are rejected without changing installed runtime', async t => {
  const directory = await temp(t);
  const member = 'codex-aarch64-apple-darwin';
  const archive = join(directory, 'codex.tar.gz');
  await writeFile(join(directory, member), 'binary');
  await writeFile(join(directory, 'unexpected'), 'untrusted');
  execFileSync('tar', ['-czf', archive, '-C', directory, member, 'unexpected']);
  await assert.rejects(extractCodexArchive({ archive, destination: join(directory, 'codex'), member, sha256: hash(await readFile(archive)) }), /members/);
});

test('bundled runtime installs only after digest verification and repairs tampering', async t => {
  const directory = await temp(t);
  const sourceDir = join(directory, 'bundled');
  const destination = join(directory, 'private', 'codex');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'codex'), 'trusted-binary');
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify({ version: CODEX_VERSION, arch: process.arch, sha256: hash('trusted-binary') }));
  await installBundledCodex({ sourceDir, destination, platform: 'darwin' });
  assert.equal(await readFile(destination, 'utf8'), 'trusted-binary');
  await writeFile(destination, 'tampered');
  await installBundledCodex({ sourceDir, destination, platform: 'darwin' });
  assert.equal(await readFile(destination, 'utf8'), 'trusted-binary');
  await writeFile(join(sourceDir, 'codex'), 'wrong');
  await assert.rejects(installBundledCodex({ sourceDir, destination, platform: 'darwin' }), /integrity/);
});


test('failed or oversized downloads do not replace installed Codex', async t => {
  const directory = await temp(t);
  await writeFile(join(directory, 'codex'), 'working');
  const request = async response => assert.rejects(installCodex({ destination: directory, platform: 'darwin', fetchImpl: async url => {
    assert.match(url, /^https:\/\/github.com\/openai\/codex\//);
    return response;
  } }));
  await request(new Response('Unavailable', { status: 503 }));
  await request(new Response('Too large', { headers: { 'content-length': String(210 * 1024 * 1024) } }));
  await request(new Response('tampered archive'));
  assert.equal(await readFile(join(directory, 'codex'), 'utf8'), 'working');
});

test('corrupted encrypted credentials never return plaintext or an empty valid session', async t => {
  const directory = await temp(t);
  const file = join(directory, 'credentials');
  await writeFile(file, 'broken');
  const store = createSecureStore({ file, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw Error('raw crypto detail'); } } });
  await assert.rejects(store.read(), error => error.message.includes('could not be opened') && !error.message.includes('crypto'));
});


test('Windows Codex package targets preserve official helpers and pinned package hashes', () => {
  assert.equal(codexTarget('x64', 'win32').sha256, '901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522');
  assert.equal(codexTarget('arm64', 'win32').sha256, '6bbada389cd1ce26783e837fd9ba4711fb4542f432044f7955139e27e27acfde');
  for (const arch of ['x64', 'arm64']) {
    const target = codexTarget(arch, 'win32');
    assert.match(target.url, /codex-package-(x86_64|aarch64)-pc-windows-msvc\.tar\.gz$/);
    assert.equal(target.member, 'bin/codex.exe');
    assert.ok(windowsCodexFiles.includes('codex-resources/codex-windows-sandbox-setup.exe'));
    assert.ok(windowsCodexFiles.includes('codex-path/rg.exe'));
  }
  assert.throws(() => codexTarget('x64', 'linux'), /platform/);
});

test('Windows package extracts only its fixed file list and rejects extra files before mutation', async t => {
  const directory = await temp(t);
  const fixture = join(directory, 'fixture');
  const archive = join(directory, 'package.tar.gz');
  const destination = join(directory, 'runtime', 'bin', 'codex.exe');
  for (const file of windowsCodexFiles) {
    await mkdir(join(fixture, file, '..'), { recursive: true });
    await writeFile(join(fixture, file), file);
  }
  execFileSync('tar', ['-czf', archive, '-C', fixture, ...windowsCodexFiles]);
  const target = { ...codexTarget('x64', 'win32'), sha256: hash(await readFile(archive)) };
  await extractCodexArchive({ archive, destination, ...target });
  assert.equal(await readFile(destination, 'utf8'), 'bin/codex.exe');
  assert.equal(await readFile(join(directory, 'runtime', 'codex-path', 'rg.exe'), 'utf8'), 'codex-path/rg.exe');
  await writeFile(join(fixture, 'unexpected.ps1'), 'must not run');
  execFileSync('tar', ['-czf', archive, '-C', fixture, ...windowsCodexFiles, 'unexpected.ps1']);
  await assert.rejects(extractCodexArchive({ archive, destination, ...target, sha256: hash(await readFile(archive)) }), /members/);
  assert.equal(await readFile(destination, 'utf8'), 'bin/codex.exe');
});

test('Windows bundled package verifies every helper and installs preserved executable layout', async t => {
  const directory = await temp(t);
  const sourceDir = join(directory, 'source');
  const files = {};
  const fixture = file => {
    if (file === 'codex-package.json') return JSON.stringify({ layoutVersion: 1, version: CODEX_VERSION, target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' });
    if (!/\.(exe|dll)$/.test(file)) return file;
    const bytes = Buffer.alloc(128);
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    return Buffer.concat([bytes, Buffer.from(file)]);
  };
  for (const file of windowsCodexFiles) {
    await mkdir(join(sourceDir, file, '..'), { recursive: true });
    await writeFile(join(sourceDir, file), fixture(file));
    files[file] = hash(fixture(file));
  }
  const manifest = { version: CODEX_VERSION, platform: 'win32', arch: 'x64', machine: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe', sha256: files['bin/codex.exe'], files };
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(manifest));
  const destination = join(directory, 'private', 'codex.exe');
  assert.equal(await installBundledCodex({ sourceDir, destination, platform: 'win32', arch: 'x64' }), join(directory, 'private', 'bin', 'codex.exe'));
  assert.deepEqual(await readFile(join(directory, 'private', 'codex-resources', 'codex-command-runner.exe')), fixture('codex-resources/codex-command-runner.exe'));
  const installedHelper = join(directory, 'private', 'codex-path', 'rg.exe');
  await writeFile(installedHelper, 'tampered installed helper');
  await installBundledCodex({ sourceDir, destination, platform: 'win32', arch: 'x64' });
  assert.deepEqual(await readFile(installedHelper), fixture('codex-path/rg.exe'));
  const helper = join(sourceDir, 'codex-path', 'rg.exe');
  const invalidMachine = fixture('codex-path/rg.exe');
  invalidMachine.writeUInt16LE(0xaa64, 68);
  await writeFile(helper, invalidMachine);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify({ ...manifest, files: { ...files, 'codex-path/rg.exe': hash(invalidMachine) } }));
  await assert.rejects(installBundledCodex({ sourceDir, destination, platform: 'win32', arch: 'x64' }), /architecture/);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(helper, 'tampered');
  await assert.rejects(installBundledCodex({ sourceDir, destination, platform: 'win32', arch: 'x64' }), /integrity/);
  await assert.rejects(installBundledCodex({ sourceDir, destination, platform: 'darwin', arch: 'x64' }), /platform/);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify({ ...manifest, files: { ...files, '../escape.exe': hash('escape') } }));
  await assert.rejects(installBundledCodex({ sourceDir, destination, platform: 'win32', arch: 'x64' }), /files/);
});


test('Codex archives reject link entries even when their names and digest match', { skip: process.platform === 'win32' }, async t => {
  const directory = await temp(t);
  const member = 'codex-aarch64-apple-darwin';
  const archive = join(directory, 'links.tar.gz');
  await symlink('/outside-sitecad', join(directory, member));
  execFileSync('tar', ['-czf', archive, '-C', directory, member]);
  await assert.rejects(extractCodexArchive({ archive, destination: join(directory, 'installed'), member, sha256: hash(await readFile(archive)) }), /types/);
});
