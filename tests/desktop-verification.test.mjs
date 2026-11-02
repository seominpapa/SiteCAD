import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDesktop } from '../scripts/verify-desktop.mjs';

test('desktop verification refuses personal profiles outside a clean CI environment', async () => {
  const previous = process.env.CI;
  delete process.env.CI;
  try { await assert.rejects(verifyDesktop({ executable: process.execPath, outputDirectory: '/tmp/unused' }), /clean CI/); }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('desktop verification rejects relative executables before starting any process', async () => {
  const previous = process.env.CI;
  process.env.CI = 'true';
  try { await assert.rejects(verifyDesktop({ executable: 'SiteCAD.exe', outputDirectory: '/tmp/unused' }), /absolute executable/); }
  finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});
