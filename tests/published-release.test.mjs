import test from 'node:test';
import assert from 'node:assert/strict';
import { assetNames, checksumEntries, preparePublishedRelease, publishedSourceCommit, releaseBase, releaseVersion } from '../scripts/verify-published-release.mjs';

test('published download checks accept only the fixed supported release files', () => {
  assert.equal(releaseVersion, '0.16.3');
  assert.equal(assetNames('darwin')[1], 'SiteCAD-0.16.3-macOS-arm64.dmg');
  assert.equal(assetNames('win32')[1], 'SiteCAD-0.16.3-Windows-x64-Setup.exe');
  assert.throws(() => assetNames('linux'));
  assert.equal(new URL(assetNames('win32')[0], releaseBase).href, 'https://github.com/seominpapa/SiteCAD/releases/download/v0.16.3/SiteCAD-0.16.3-local-web-Windows.zip');
});

test('published checksums reject incomplete, duplicate and unsafe names', () => {
  const valid = Array.from({ length: 6 }, (_, i) => `${'a'.repeat(64)}  file-${i}.zip`).join('\n');
  assert.equal(checksumEntries(valid).size, 6);
  assert.throws(() => checksumEntries(valid + '\n' + valid.split('\n')[0]), /Duplicate/);
  assert.throws(() => checksumEntries(valid.replace('file-0.zip', '../private')), /Malformed/);
  assert.throws(() => checksumEntries(valid.split('\n').slice(1).join('\n')));
});

test('published source proof binds the released tag commit to the successful build record', () => {
  const sha = 'a'.repeat(40);
  const ref = { ref: 'refs/tags/v0.16.3', object: { type: 'commit', sha } };
  const evidence = { version: '0.16.3', releaseTag: 'v0.16.3', sourceCommit: sha, ci: { headSha: sha, conclusion: 'success' } };
  assert.equal(publishedSourceCommit(ref, evidence), sha);
  assert.throws(() => publishedSourceCommit({ ...ref, object: { type: 'commit', sha: 'main' } }, evidence));
  assert.throws(() => publishedSourceCommit({ ...ref, ref: 'refs/tags/v0.16.0' }, evidence));
  assert.throws(() => publishedSourceCommit({ ...ref, object: { type: 'tag', sha } }, evidence));
  assert.throws(() => publishedSourceCommit(ref, { ...evidence, sourceCommit: 'b'.repeat(40) }));
  assert.throws(() => publishedSourceCommit(ref, { ...evidence, ci: { headSha: sha, conclusion: 'failure' } }));
});

test('published installer checks refuse local personal profiles', async () => {
  const ci = process.env.CI, actions = process.env.GITHUB_ACTIONS;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  try { await assert.rejects(preparePublishedRelease(), /clean hosted CI/); }
  finally {
    if (ci !== undefined) process.env.CI = ci;
    if (actions !== undefined) process.env.GITHUB_ACTIONS = actions;
  }
});
