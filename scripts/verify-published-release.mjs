import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const releaseCommit = 'e74d4eae3bf73d5f668a0e6b3f9be9447e9cb03f';
export const releaseBase = 'https://github.com/seominpapa/SiteCAD/releases/download/v0.16.0/';
export const assetNames = platform => {
  assert.ok(['win32', 'darwin'].includes(platform));
  return platform === 'win32'
    ? ['SiteCAD-0.16.0-local-web-Windows.zip', 'SiteCAD-0.16.0-Windows-x64-Setup.exe']
    : ['SiteCAD-0.16.0-local-web-macOS.zip', 'SiteCAD-0.16.0-macOS-arm64.dmg'];
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
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(name, directory, metadata) {
  const response = await fetch(releaseBase + name, { signal: AbortSignal.timeout(600000) });
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
  const response = await fetch('https://api.github.com/repos/seominpapa/SiteCAD/releases/tags/v0.16.0', { headers: { 'User-Agent': 'SiteCAD-first-install-verification' }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.tag_name, 'v0.16.0');
  assert.equal(metadata.draft, false);
  assert.equal(metadata.prerelease, false);
  assert.equal(metadata.target_commitish, releaseCommit);
  const reports = await Promise.all(['SHA256SUMS.txt', 'sitecad-verification.json', ...assetNames(process.platform)].map(name => download(name, directory, metadata)));
  const sums = checksumEntries(await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8'));
  for (const report of reports.filter(item => item.name !== 'SHA256SUMS.txt')) assert.equal(report.sha256, sums.get(report.name), `Published checksum mismatch: ${report.name}`);
  const evidence = JSON.parse(await readFile(join(directory, 'sitecad-verification.json'), 'utf8'));
  assert.equal(evidence.version, '0.16.0');
  assert.equal(evidence.sourceCommit, releaseCommit);
  assert.equal(evidence.ci.conclusion, 'success');
  await writeFile(join(output, 'published-downloads.json'), `${JSON.stringify({ release: 'v0.16.0', commit: releaseCommit, platform: process.platform,
    arch: process.arch, downloadedAt: new Date().toISOString(), assets: reports, desktopProfileAbsent: true,
    limitations: ['Programmatic public downloads do not reproduce browser quarantine, Gatekeeper, or SmartScreen dialogs.'] }, null, 2)}\n`);
  console.log(`Public v0.16.0 downloads verified for ${process.platform}/${process.arch}; no installer rebuild performed.`);
}
if (import.meta.main) await preparePublishedRelease();
