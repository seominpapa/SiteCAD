import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adaptEditorHtml } from '../scripts/install-editor.mjs';

test('local HTML adaptation identifies its author and date while preserving engine links', () => {
  const source = '<head><link rel="manifest" href="manifest.json"><link rel="icon" href="icon.png"><script>// Offline support: cache\nregisterCache();</script><script type="module" src="/app/fixed-engine.js"></script></head>';
  const result = adaptEditorHtml(source, '2026-10-24T09:00:00.000Z');
  assert.match(result, /SiteCAD contributors/);
  assert.match(result, /2026-10-24T09:00:00.000Z/);
  assert.match(result, /startup and caching/);
  assert.match(result, /opencadstudio\.automation/);
  assert.match(result, /src="\/app\/fixed-engine\.js"/);
  assert.doesNotMatch(result, /registerCache|rel="manifest"|rel="icon"/);
});

test('desktop packaging carries root licensing and source-build documents', async () => {
  const source = await readFile(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8');
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SOURCE_BUILD.md', 'desktop/licenses']) assert.ok(source.includes(`'${name}'`), name);
});

test('source notices distinguish the engine revision from the old reference archive', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0/);
  assert.match(notices, /correspondence.*not.*established/i);
  assert.match(notices, /SOURCE_BUILD\.md/);
});

test('the installed HTML has an explicit change notice and a matching local hash separate from upstream bytes', async () => {
  const html = await readFile(new URL('../vendor/editor/index.html', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../vendor/editor/manifest.local.json', import.meta.url), 'utf8'));
  assert.match(html.toString('utf8'), /Modified by SiteCAD contributors[\s\S]*2026-10-24/);
  const modification = manifest.modifications.find(item => item.path === 'index.html');
  assert.equal(modification.noticeAddedOn, '2026-10-24');
  assert.equal(modification.localSha256, createHash('sha256').update(html).digest('hex'));
  assert.notEqual(modification.localSha256, manifest.files.find(item => item.path === 'index.html').sha256);
  assert.equal(manifest.files.find(item => item.path.endsWith('_bg.wasm') && !item.path.includes('/')).sha256, 'd6a0960716b943f338fb4cdd17f72dde59f52eddedb31bb5f6a07b3f658bc6af');
});

test('identified engine icon and font redistribution notices are included', async () => {
  for (const name of ['Phosphor-LICENSE.txt', 'Iced-LICENSE.txt', 'Iced-AW-LICENSE.txt', 'Druid-LICENSE.txt', 'Fira-OFL.txt']) {
    const notice = await readFile(new URL(`../vendor/editor/licenses/${name}`, import.meta.url), 'utf8');
    assert.match(notice, /Permission|License|LICENSE/);
    assert.ok(notice.length > 1000);
  }
});

test('the locally downloadable source archive matches the verified upstream revision archive', async () => {
  const archive = await readFile(new URL('../vendor/editor/source/OpenCADStudio-b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0-source.tar.gz', import.meta.url));
  assert.equal(createHash('sha256').update(archive).digest('hex'), '2c01e345379ab8b54ae5c007a9637f27f7e0b3d514800c187e7d3e9839e57bb4');
  const page = await readFile(new URL('../public/licenses.html', import.meta.url), 'utf8');
  assert.match(page, /href="\/legal\/opencadstudio-source.tar.gz"/);
});
