import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createSecureStore, startupFailure, saveStartupFailure } from '../desktop/runtime.mjs';

test('Windows encryption failure never tells users to unlock the Mac keychain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSecureStore({ file: join(directory, 'credentials.enc'), platform: 'win32', safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(store.write({ synthetic: true }), error => {
    assert.doesNotMatch(error.message, /macOS|Keychain|키체인/i);
    assert.match(error.message, /Windows/);
    return true;
  });
});

test('unrelated startup failures do not blame credentials and diagnostics contain no raw secrets', () => {
  const failure = startupFailure({ error: Object.assign(Error('api_key=private-value secret/path'), { code: 'EACCES', path: 'private/path' }), stage: 'runtime', platform: 'win32', version: '0.16.5' });
  assert.match(failure.message, /내장 실행 파일/);
  assert.match(failure.message, /EACCES/);
  assert.doesNotMatch(failure.message, /키체인|keychain|macOS/i);
  assert.equal(failure.diagnostic.stage, 'runtime');
  assert.equal(failure.diagnostic.code, 'EACCES');
  assert.doesNotMatch(JSON.stringify(failure), /private-value|secret\/path|private\/path/);
});

test('decryption and unavailable encryption have OS-specific guidance and preserve existing ciphertext', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.enc');
  await writeFile(file, 'original encrypted bytes');
  for (const platform of ['win32', 'darwin']) {
    const store = createSecureStore({ file, platform, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw Error('private crypto details'); } } });
    await assert.rejects(store.read(), error => {
      assert.equal(error.code, 'SITECAD_CREDENTIALS_DECRYPT');
      const failure = startupFailure({ error, platform, stage: 'settings', version: '0.16.5' });
      assert.match(failure.message, platform === 'win32' ? /Windows/ : /macOS/);
      assert.doesNotMatch(failure.message, platform === 'win32' ? /macOS|키체인|keychain/i : /Windows/);
      assert.doesNotMatch(JSON.stringify(failure), /private crypto details/);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), 'original encrypted bytes');
  }
});

test('startup diagnostics are saved independently of encrypted login files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failure = startupFailure({ error: Error('sensitive unknown message'), stage: 'server', platform: 'win32', version: '0.16.5' });
  const file = join(directory, 'diagnostics', 'startup-error.json');
  await saveStartupFailure(file, failure.diagnostic);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.stage, 'server');
  assert.equal(data.code, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(data), /sensitive/);
  await assert.rejects(saveStartupFailure(join(file, 'invalid'), data));
});

test('startup diagnostics bound unknown phases and codes without repeating untrusted error text', () => {
  for (const stage of ['profile', 'settings', 'window', 'server', 'untrusted']) {
    const result = startupFailure({ error: { code: 'Bearer private-token' }, stage, version: '0.16.5', platform: 'win32' });
    assert.equal(result.diagnostic.code, 'UNKNOWN');
    assert.equal(result.diagnostic.stage, stage === 'untrusted' ? 'unknown' : stage);
    assert.doesNotMatch(JSON.stringify(result), /private-token|macOS/);
  }
  assert.doesNotMatch(startupFailure({ error: Error(), stage: 'runtime', version: '0.16.5', platform: 'darwin' }).message, /Windows/);
});

test('known bundled-runtime validation failures have safe specific codes', () => {
  for (const [message, code] of [
    ['Bundled Codex integrity check failed', 'SITECAD_RUNTIME_INTEGRITY'],
    ['Bundled Codex version, platform or architecture is invalid', 'SITECAD_RUNTIME_INVALID'],
    ['Bundled Codex files are invalid', 'SITECAD_RUNTIME_INVALID'],
    ['Bundled Codex package metadata is invalid', 'SITECAD_RUNTIME_INVALID'],
    ['Codex Windows binary architecture is invalid', 'SITECAD_RUNTIME_ARCH'],
  ]) {
    const failure = startupFailure({ error: Error(message), stage: 'runtime', platform: 'win32', version: '0.16.5' });
    assert.equal(failure.diagnostic.code, code);
  }
  assert.equal(startupFailure({ error: new SyntaxError('private content'), stage: 'runtime', platform: 'win32', version: '0.16.5' }).diagnostic.code, 'SITECAD_RUNTIME_MANIFEST');
});

test('actual desktop startup catch records a runtime failure instead of showing the Mac keychain instruction', async () => {
  const source = (await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../desktop/main.mjs', import.meta.url).href));
  for (const cannotSave of [false, true]) {
    let diagnostic, dialogText, finish;
    const completed = new Promise(resolveDone => { finish = resolveDone; });
    const app = {
      setName() {}, setPath() {}, getPath: () => '/synthetic-profile', getVersion: () => '0.16.5',
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {}, quit: () => finish(),
    };
    vm.runInNewContext(source, {
      app, join, dirname, resolve, fileURLToPath,
      process: { argv: [], platform: 'win32', on() {} },
      mkdir: async () => {}, installBundledCodex: async () => { throw Object.assign(Error('sensitive/private'), { code: 'EACCES' }); },
      desktopPaths: () => ({ codexHome: '/synthetic-profile/codex-home', workspace: '/synthetic-profile/workspace', runtime: '/synthetic-profile/runtime' }),
      startupFailure: options => startupFailure({ ...options, platform: 'win32' }),
      saveStartupFailure: async (_file, data) => { if (cannotSave) throw Error('denied'); diagnostic = data; },
      dialog: { showErrorBox: (_title, text) => { dialogText = text; } },
    });
    await completed;
    assert.match(dialogText, /내장 실행 파일.*\n오류 코드: EACCES/);
    assert.doesNotMatch(dialogText, /macOS|키체인|sensitive/);
    if (cannotSave) assert.match(dialogText, /진단 파일을 저장하지 못했습니다/);
    else { assert.equal(diagnostic.stage, 'runtime'); assert.match(dialogText, /startup-error.json/); }
  }
});
