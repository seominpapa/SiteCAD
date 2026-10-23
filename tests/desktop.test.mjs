import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { desktopPaths, isAllowedAuthUrl, createSecureStore, installBundledCodex } from '../desktop/runtime.mjs';
import { CODEX_VERSION, codexTarget, extractCodexArchive, installCodex } from '../scripts/install-codex.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('desktop paths isolate runtime, workspace and Codex settings under app data', () => {
  const paths = desktopPaths('/private/tmp/SiteCAD');
  for (const value of Object.values(paths)) assert.ok(value.startsWith('/private/tmp/SiteCAD/'));
  assert.equal(paths.codexHome, '/private/tmp/SiteCAD/codex-home');
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
  assert.equal((await stat(file)).mode & 0o777, 0o600);
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
    const target = codexTarget(arch);
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
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', directory, member]);
  await writeFile(destination, 'old-valid-binary');
  await assert.rejects(extractCodexArchive({ archive, destination, member, sha256: '0'.repeat(64) }), /integrity/);
  assert.equal(await readFile(destination, 'utf8'), 'old-valid-binary');
  await extractCodexArchive({ archive, destination, member, sha256: hash(await readFile(archive)) });
  assert.equal(await readFile(destination, 'utf8'), 'native-binary');
  assert.equal((await stat(destination)).mode & 0o777, 0o755);
});

test('archives with additional members are rejected without changing installed runtime', async t => {
  const directory = await temp(t);
  const member = 'codex-aarch64-apple-darwin';
  const archive = join(directory, 'codex.tar.gz');
  await writeFile(join(directory, member), 'binary');
  await writeFile(join(directory, 'unexpected'), 'untrusted');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', directory, member, 'unexpected']);
  await assert.rejects(extractCodexArchive({ archive, destination: join(directory, 'codex'), member, sha256: hash(await readFile(archive)) }), /members/);
});

test('bundled runtime installs only after digest verification and repairs tampering', async t => {
  const directory = await temp(t);
  const sourceDir = join(directory, 'bundled');
  const destination = join(directory, 'private', 'codex');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'codex'), 'trusted-binary');
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify({ version: CODEX_VERSION, arch: process.arch, sha256: hash('trusted-binary') }));
  await installBundledCodex({ sourceDir, destination });
  assert.equal(await readFile(destination, 'utf8'), 'trusted-binary');
  await writeFile(destination, 'tampered');
  await installBundledCodex({ sourceDir, destination });
  assert.equal(await readFile(destination, 'utf8'), 'trusted-binary');
  await writeFile(join(sourceDir, 'codex'), 'wrong');
  await assert.rejects(installBundledCodex({ sourceDir, destination }), /integrity/);
});


test('failed or oversized downloads do not replace installed Codex', async t => {
  const directory = await temp(t);
  await writeFile(join(directory, 'codex'), 'working');
  const request = async response => assert.rejects(installCodex({ destination: directory, fetchImpl: async url => {
    assert.match(url, /^https:\/\/github.com\/openai\/codex\//);
    return response;
  } }));
  await request(new Response('Unavailable', { status: 503 }));
  await request(new Response('Too large', { headers: { 'content-length': String(170 * 1024 * 1024) } }));
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
