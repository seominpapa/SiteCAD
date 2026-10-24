import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKcscInstaller } from '../lib/kcsc-runtime.mjs';
import { probeKcsc, KCSC_QUERY_TOOLS } from '../lib/kcsc-connection.mjs';

test('native pinned KCSC bootstrap installs isolated Python and discovers real MCP tools without credentials', {
  skip: process.env.SITECAD_TEST_KCSC_INSTALL !== '1', timeout: 600000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'SiteCAD KCSC native '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const installer = createKcscInstaller({ dataDir });
  assert.equal((await installer.status()).installed, false);
  const installed = await installer.install();
  assert.equal(installed.installed, true);
  assert.equal((await installer.status()).command, installed.command);
  const result = await probeKcsc({ ...installed, env: { KCSC_DOMAIN: '전체' } }, { dataDir, verifyKey: false });
  assert.equal(result.verified, false);
  assert.equal(result.tools.length, 13);
  assert.equal(KCSC_QUERY_TOOLS.every(name => result.tools.includes(name)), true);
  t.diagnostic(`Discovered ${result.tools.length} native MCP tools; ${KCSC_QUERY_TOOLS.length} query tools are enabled for SiteCAD.`);
});
