import test from 'node:test';
import assert from 'node:assert/strict';
import { assetNames, checksumEntries, preparePublishedRelease, releaseBase } from '../scripts/verify-published-release.mjs';

test('published release checks accept only fixed safe asset names and complete checksum manifests', () => {
  assert.equal(assetNames('darwin')[1], 'SiteCAD-0.16.0-macOS-arm64.dmg');
  assert.equal(assetNames('win32')[1], 'SiteCAD-0.16.0-Windows-x64-Setup.exe');
  assert.throws(() => assetNames('linux'));
  assert.equal(new URL(assetNames('win32')[0], releaseBase).pathname.includes('/v0.16.0/'), true);
  const valid = Array.from({ length: 6 }, (_, i) => `${'a'.repeat(64)}  file-${i}.zip`).join('\n');
  assert.equal(checksumEntries(valid).size, 6);
  assert.throws(() => checksumEntries(valid + '\n' + valid.split('\n')[0]), /Duplicate/);
  assert.throws(() => checksumEntries(valid.replace('file-0.zip', '../private')), /Malformed/);
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
