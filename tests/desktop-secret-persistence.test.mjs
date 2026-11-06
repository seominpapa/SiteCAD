import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopSecretStores } from '../desktop/runtime.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-desktop-secrets-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let saved;
  const entry = { getPassword: async () => saved ?? null, setPassword: async value => { saved = value; } };
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: () => { throw Error('New Windows writes must not depend on Chromium Local State'); },
    decryptString: bytes => { assert.equal(bytes.subarray(0, 3).toString(), 'v10'); return bytes.subarray(3).toString(); } };
  const stores = () => createDesktopSecretStores({ dataDir, platform: 'win32', safeStorage, entry });
  return { dataDir, entry, safeStorage, stores };
}

test('Windows desktop first write persists OS key before ciphertext and survives a fresh store instance', async t => {
  const f = await fixture(t), file = join(f.dataDir, 'llm-secrets.enc');
  const setPassword = f.entry.setPassword;
  f.entry.setPassword = async value => {
    await assert.rejects(stat(file), { code: 'ENOENT' });
    await setPassword(value);
  };
  const value = { synthetic: 'private-value' };
  await f.stores().llm.write(value);
  assert.deepEqual(await f.stores().llm.read(), value);
  const bytes = await readFile(file);
  assert.ok(!bytes.includes('private-value'));
  const magic = Buffer.from('SITECADWEB1\0');
  assert.ok(bytes.subarray(0, magic.length).equals(magic));
});

test('Windows reads legacy Electron ciphertext unchanged and migrates only a successful write', async t => {
  const f = await fixture(t), file = join(f.dataDir, 'credentials.enc');
  const before = Buffer.from('v10' + JSON.stringify({ synthetic: 'legacy' }));
  await writeFile(file, before);
  assert.deepEqual(await f.stores().auth.read(), { synthetic: 'legacy' });
  assert.deepEqual(await readFile(file), before);
  assert.equal(await f.entry.getPassword(), null);
  await f.stores().auth.write({ synthetic: 'updated' });
  assert.deepEqual(await f.stores().auth.read(), { synthetic: 'updated' });
  assert.ok(!(await readFile(file)).equals(before));
});

test('missing Windows key never replaces any existing native encrypted store', async t => {
  const f = await fixture(t);
  await f.stores().apis.write({ synthetic: 'keep' });
  const file = join(f.dataDir, 'api-secrets.enc'), before = await readFile(file);
  const denied = createDesktopSecretStores({ dataDir: f.dataDir, platform: 'win32', safeStorage: f.safeStorage,
    entry: { getPassword: async () => null, setPassword: async () => assert.fail('Must not generate a replacement key') } });
  await assert.rejects(denied.auth.write({ synthetic: 'new' }), /Windows/);
  await assert.rejects(denied.apis.read(), /Windows/);
  assert.deepEqual(await readFile(file), before);
});

test('legacy decrypt failure, malformed ciphertext and denied keyring preserve original Windows files', async t => {
  const f = await fixture(t), file = join(f.dataDir, 'llm-secrets.enc');
  for (const before of [Buffer.from('v10invalid'), Buffer.from('unknown')]) {
    await writeFile(file, before);
    const store = f.stores().llm;
    await assert.rejects(store.read());
    await assert.rejects(store.write({ synthetic: 'new' }));
    assert.deepEqual(await readFile(file), before);
    assert.equal(await f.entry.getPassword(), null);
  }
  await rm(file);
  const denied = createDesktopSecretStores({ dataDir: f.dataDir, platform: 'win32', safeStorage: f.safeStorage,
    entry: { getPassword: async () => null, setPassword: async () => { throw Error('private OS detail'); } } });
  await assert.rejects(denied.llm.write({ synthetic: 'new' }), error => /Windows/.test(error.message) && !error.message.includes('private OS detail'));
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('Mac desktop retains its existing Electron store and never requests the Windows keyring', async t => {
  const f = await fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from('mac:' + text), decryptString: bytes => bytes.toString().slice(4) };
  const stores = createDesktopSecretStores({ dataDir: f.dataDir, platform: 'darwin', safeStorage,
    entry: { getPassword: () => assert.fail('Mac must retain Keychain identity') } });
  await stores.auth.write({ synthetic: true });
  assert.deepEqual(await stores.auth.read(), { synthetic: true });
  assert.match(await readFile(join(f.dataDir, 'credentials.enc'), 'utf8'), /^mac:/);
});
