import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetNames, checksumEntries, downloadPublishedAsset, githubMetadataRequest, preparePublishedRelease, publishedSourceCommit, releaseBase, releaseVersion } from '../scripts/verify-published-release.mjs';

test('GitHub metadata authorization is restricted to fixed API endpoints on hosted CI without redirects', () => {
  const token = ['test', 'only'].join('-');
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_TOKEN: token };
  for (const path of ['releases/tags/v0.16.5', 'git/ref/tags/v0.16.5']) {
    const request = githubMetadataRequest(path, env);
    assert.equal(request.url, `https://api.github.com/repos/seominpapa/SiteCAD/${path}`);
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.options.redirect, 'error');
  }
  assert.equal(githubMetadataRequest('releases/tags/v0.16.5', {}).options.headers.Authorization, undefined);
  for (const flags of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    assert.throws(() => githubMetadataRequest('releases/tags/v0.16.5', { ...flags, GITHUB_TOKEN: token }), /hosted CI/);
  }
  for (const path of ['https://example.test/private', '../private', 'releases/tags/v0.16.5?redirect=other', 'releases/tags/v0.16.3', 'releases/tags/v0.16.2']) {
    assert.throws(() => githubMetadataRequest(path, env), /Fixed GitHub metadata/);
  }
});

test('release asset downloads remain anonymous even when metadata uses a GitHub token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-public-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.GITHUB_TOKEN;
  const token = ['test', 'only'].join('-');
  process.env.GITHUB_TOKEN = token;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous; });
  const name = 'sitecad-verification.json', bytes = Buffer.from('{"version":"0.16.5"}');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = { assets: [{ name, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256}` }] };
  const report = await downloadPublishedAsset(name, directory, metadata, async (url, options) => {
    assert.equal(url, releaseBase + name);
    assert.equal(options.headers, undefined);
    assert.equal(options.credentials, undefined);
    assert.ok(!JSON.stringify(options).includes(token));
    assert.doesNotMatch(JSON.stringify(options), /Authorization/);
    return new Response(bytes);
  });
  assert.equal(report.anonymousDownload, true);
  assert.equal(await readFile(join(directory, name), 'utf8'), bytes.toString());
});

test('public verification uses the default branch tools and confines the token to the metadata step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/published-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.equal(workflow.split('GITHUB_TOKEN:').length - 1, 1);
  assert.match(workflow, /- name: Download public release assets[^\n]*\n        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n        run: node scripts\/verify-published-release\.mjs/);
});

test('published download checks accept only the fixed supported release files', () => {
  assert.equal(releaseVersion, '0.16.5');
  assert.equal(assetNames('darwin')[1], 'SiteCAD-0.16.5-macOS-arm64.dmg');
  assert.equal(assetNames('win32')[1], 'SiteCAD-0.16.5-Windows-x64-Setup.exe');
  assert.throws(() => assetNames('linux'));
  assert.equal(new URL(assetNames('win32')[0], releaseBase).href, 'https://github.com/seominpapa/SiteCAD/releases/download/v0.16.5/SiteCAD-0.16.5-local-web-Windows.zip');
});

test('development metadata stays consistent and README downloads stay on published 0.16.4', async () => {
  const [packageText, lockText, readme, workflow] = await Promise.all([
    '../package.json', '../package-lock.json', '../README.md', '../.github/workflows/published-release.yml',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.equal(JSON.parse(packageText).version, releaseVersion);
  const lock = JSON.parse(lockText);
  assert.equal(lock.version, releaseVersion);
  assert.equal(lock.packages[''].version, releaseVersion);
  for (const name of [...assetNames('darwin'), ...assetNames('win32')]) {
    const publishedUrl = (releaseBase + name).replaceAll(releaseVersion, '0.16.4');
    assert.ok(readme.includes(publishedUrl), `Missing published README download: ${publishedUrl}`);
  }
  assert.ok(!readme.includes('0.16.5'), 'Unreleased version must not be advertised in README');
  assert.ok(workflow.includes(`Published ${releaseVersion} first-install verification`));
  assert.ok(workflow.includes(`SiteCAD-${releaseVersion}-local-web-`));
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
  const ref = { ref: 'refs/tags/v0.16.5', object: { type: 'commit', sha } };
  const evidence = { version: '0.16.5', releaseTag: 'v0.16.5', sourceCommit: sha, ci: { headSha: sha, conclusion: 'success' } };
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
