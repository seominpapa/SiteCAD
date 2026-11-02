import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('executable modules remain safe to import with a non-file first argument', async () => {
  const files = ['local-web.mjs', 'server.mjs', 'scripts/install-codex.mjs', 'scripts/install-editor.mjs',
    'scripts/build-local-web.mjs', 'scripts/build-desktop.mjs', 'scripts/update-model-catalog.mjs',
    'scripts/verify-desktop.mjs', 'lib/sitecad-mcp.mjs', 'lib/mcp-launcher.mjs'];
  const urls = files.map(file => new URL(`../${file}`, import.meta.url).href);
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
    `for (const url of ${JSON.stringify(urls)}) await import(url); console.log('imports completed');`, 'nonexistent-user-argument'], { timeout: 15000 });
  assert.equal(stdout.trim(), 'imports completed');
});

test('local web entry starts through a linked installation directory', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'SiteCAD 실행 경로 '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const linked = join(temporary, '연결된 설치 폴더');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(execute(process.execPath, [join(linked, 'local-web.mjs')], {
    env: { ...process.env, SITECAD_WEB_DATA_DIR: 'relative-path-rejected-before-startup' }, timeout: 15000,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SiteCAD data path must be absolute/);
    return true;
  });
});
