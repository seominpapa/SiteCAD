import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const releaseVersion = '0.16.3';
const releaseTag = `v${releaseVersion}`;
export const releaseBase = `https://github.com/seominpapa/SiteCAD/releases/download/${releaseTag}/`;
export const assetNames = platform => {
  assert.ok(['win32', 'darwin'].includes(platform));
  return platform === 'win32'
    ? [`SiteCAD-${releaseVersion}-local-web-Windows.zip`, `SiteCAD-${releaseVersion}-Windows-x64-Setup.exe`]
    : [`SiteCAD-${releaseVersion}-local-web-macOS.zip`, `SiteCAD-${releaseVersion}-macOS-arm64.dmg`];
};
export function checksumEntries(text) {
  const entries = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(match, 'Malformed published checksum line');
    assert.ok(!entries.has(match[2]), 'Duplicate published checksum entry');
    entries.set(match[2], match[1]);
  }
  assert.equal(entries.size, 6);
  return entries;
}
export function publishedSourceCommit(ref, evidence) {
  assert.equal(ref.ref, `refs/tags/${releaseTag}`);
  assert.equal(ref.object?.type, 'commit');
  assert.match(ref.object?.sha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(evidence.version, releaseVersion);
  assert.equal(evidence.releaseTag, releaseTag);
  assert.equal(evidence.sourceCommit, ref.object.sha);
  assert.equal(evidence.ci?.headSha, ref.object.sha);
  assert.equal(evidence.ci?.conclusion, 'success');
  return ref.object.sha;
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function githubMetadataRequest(path, env = process.env) {
  assert.ok([`releases/tags/${releaseTag}`, `git/ref/tags/${releaseTag}`].includes(path), 'Fixed GitHub metadata endpoint required');
  if (env.GITHUB_TOKEN && (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true')) throw Error('GitHub metadata authorization requires hosted CI.');
  return { url: `https://api.github.com/repos/seominpapa/SiteCAD/${path}`, options: {
    headers: { 'User-Agent': 'SiteCAD-first-install-verification', ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  } };
}
async function githubJson(path) {
  const { url, options } = githubMetadataRequest(path);
  const response = await fetch(url, options);
  assert.equal(response.status, 200, `GitHub metadata failed: ${path}`);
  return response.json();
}
export async function downloadPublishedAsset(name, directory, metadata, fetchImpl = fetch) {
  const response = await fetchImpl(releaseBase + name, { signal: AbortSignal.timeout(600000) });
  assert.equal(response.status, 200, `Public download failed: ${name}`);
  const file = join(directory, name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx' }));
  const sha256 = await digest(file);
  const asset = metadata.assets.find(item => item.name === name);
  assert.ok(asset && asset.state === 'uploaded', `Missing release metadata: ${name}`);
  assert.equal(asset.size, (await stat(file)).size);
  assert.equal(asset.digest, `sha256:${sha256}`, `GitHub digest mismatch: ${name}`);
  return { name, sha256, bytes: asset.size, anonymousDownload: true };
}
export async function preparePublishedRelease() {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Published installer verification requires a clean hosted CI runner.');
  assert.ok(process.platform === 'win32' || process.platform === 'darwin');
  assert.equal(process.arch, process.platform === 'darwin' ? 'arm64' : 'x64');
  const profile = process.platform === 'win32' ? join(process.env.APPDATA, 'SiteCAD') : join(homedir(), 'Library/Application Support/SiteCAD');
  await assert.rejects(stat(profile), { code: 'ENOENT' }, 'Desktop profile must be absent before installation');
  const directory = resolve('dist/published-release-downloads');
  const output = resolve('dist/verification');
  await mkdir(directory, { recursive: true });
  await mkdir(output, { recursive: true });
  const [metadata, ref] = await Promise.all([githubJson(`releases/tags/${releaseTag}`), githubJson(`git/ref/tags/${releaseTag}`)]);
  assert.equal(metadata.tag_name, releaseTag);
  assert.equal(metadata.draft, false);
  assert.equal(metadata.prerelease, false);
  const reports = await Promise.all(['SHA256SUMS.txt', 'sitecad-verification.json', ...assetNames(process.platform)].map(name => downloadPublishedAsset(name, directory, metadata)));
  const sums = checksumEntries(await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8'));
  for (const report of reports.filter(item => item.name !== 'SHA256SUMS.txt')) assert.equal(report.sha256, sums.get(report.name), `Published checksum mismatch: ${report.name}`);
  const evidence = JSON.parse(await readFile(join(directory, 'sitecad-verification.json'), 'utf8'));
  const commit = publishedSourceCommit(ref, evidence);
  await writeFile(join(output, 'published-downloads.json'), `${JSON.stringify({ release: releaseTag, commit, platform: process.platform,
    arch: process.arch, downloadedAt: new Date().toISOString(), assets: reports, desktopProfileAbsent: true,
    metadataAuthentication: process.env.GITHUB_TOKEN ? 'GitHub Actions token' : 'anonymous',
    limitations: ['Programmatic public downloads do not reproduce browser quarantine, Gatekeeper, or SmartScreen dialogs.',
      'Mac DMG is a development build without distributor notarization; trust diagnostics are recorded separately.'] }, null, 2)}\n`);
  console.log(`Public ${releaseTag} downloads verified for ${process.platform}/${process.arch}; no installer rebuild performed.`);
}
if (import.meta.main) await preparePublishedRelease();
