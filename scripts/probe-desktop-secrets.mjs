import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// shortcut: disposable CI profiles and fixed fake data only; never use this probe on personal app data.
if (process.env.CI !== 'true' || !process.versions.electron) throw Error('Secret-store probe requires Electron on a clean CI machine');
const [profile, mode, action] = process.argv.slice(2);
const contained = root => { const child = relative(root, profile); return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
assert.ok(isAbsolute(profile ?? '') && [tmpdir(), process.env.RUNNER_TEMP].filter(Boolean).some(contained), 'Provide a disposable profile inside CI temp');
assert.ok(['sync', 'async'].includes(mode) && ['write', 'write-hold', 'read'].includes(action), 'Invalid probe mode/action');
const stage = value => console.log(`[secret-probe] ${JSON.stringify({mode, action, stage:value})}`);
const file = join(profile, 'probe.enc');
const value = JSON.stringify({registrations:[],activeClientId:null});
if (action !== 'read') {
  await mkdir(profile, {recursive:true});
  assert.deepEqual(await readdir(profile), [], 'Write probe must start with an empty disposable profile');
}
const { app, safeStorage } = await import('electron');
app.setName('SiteCAD Secret Probe');
app.setPath('userData', profile);
await app.whenReady();
try {
  stage('ready');
  const state = await readFile(join(profile, 'Local State'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  stage(state.os_crypt?.encrypted_key ? 'local-state-key-present' : 'local-state-key-absent');
  stage('availability-start');
  assert.equal(mode === 'sync' ? safeStorage.isEncryptionAvailable() : await safeStorage.isAsyncEncryptionAvailable(), true);
  stage('availability-complete');
  if (action === 'read') {
    const encrypted = await readFile(file);
    stage(`encrypted-prefix-${encrypted.subarray(0, 3).toString('hex')}`);
    stage('decrypt-start');
    const result = mode === 'sync' ? safeStorage.decryptString(encrypted) : (await safeStorage.decryptStringAsync(encrypted)).result;
    assert.equal(result, value);
    stage('decrypt-complete');
  } else {
    stage('encrypt-start');
    const encrypted = mode === 'sync' ? safeStorage.encryptString(value) : await safeStorage.encryptStringAsync(value);
    stage('encrypt-complete');
    stage(`encrypted-prefix-${encrypted.subarray(0, 3).toString('hex')}`);
    await writeFile(file, encrypted, {flag:'wx'});
    stage('written');
    if (action === 'write-hold') {
      stage('awaiting-forced-shutdown');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  }
  stage('passed');
  app.quit();
} catch (error) {
  stage(`failed-${error.name}`);
  app.exit(1);
}
