import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpRegistry } from '../lib/mcp-registry.mjs';
import { createKcscConnection, KCSC_QUERY_TOOLS } from '../lib/kcsc-connection.mjs';
import { kcscTarget } from '../lib/kcsc-runtime.mjs';

const PRIVATE_KEY = 'fixture-private-kcsc-key';
const REPLACEMENT_KEY = 'fixture-replacement-key';
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-kcsc-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let secrets = null, installed = false, failing = false, installCalls = 0;
  const secretStore = { read: async () => secrets, write: async value => { secrets = structuredClone(value); } };
  const registry = await createMcpRegistry({ dataDir, nodePath: process.execPath, secretStore });
  const runtime = { command: join(dataDir, 'python'), args: ['-I', '-m', 'kcsc_mcp'] };
  const probes = [];
  const connection = createKcscConnection({ dataDir, registry,
    installer: { status: async () => ({ installed, ...runtime }), install: async () => { installCalls++; installed = true; return runtime; } },
    probe: async (config, options) => {
      probes.push({ config, options });
      if (failing) throw Error(PRIVATE_KEY);
      return { tools: [...KCSC_QUERY_TOOLS, 'kcsc_design'], verified: true };
    }, now: () => new Date('2026-10-24T00:00:00Z') });
  return { connection, registry, dataDir, probes, runtime, setFailing: value => { failing = value; }, installs: () => installCalls };
}

test('KCSC requires explicit trust and a private key before any installation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.connection.status(), { configured: false, installed: false, connected: false, tools: [], count: 0 });
  for (const input of [{ apiKey: PRIVATE_KEY }, { apiKey: '', trusted: true }, { apiKey: 'key\nunsafe', trusted: true }, { apiKey: PRIVATE_KEY, trusted: true, command: '/tmp/custom' }]) {
    await assert.rejects(f.connection.save(input));
  }
  assert.equal(f.installs(), 0);
  await assert.rejects(f.connection.test({}), /등록/);
  await assert.rejects(f.connection.remove({ apiKey: PRIVATE_KEY }));
});

test('KCSC registers only query tools and never returns or writes a plaintext credential', async t => {
  const f = await fixture(t);
  const result = await f.connection.save({ apiKey: PRIVATE_KEY, trusted: true });
  assert.equal(result.configured, true); assert.equal(result.connected, true); assert.equal(result.count, 7); assert.equal(result.advertisedCount, 8);
  assert.equal(f.probes[0].config.env.KCSC_API_KEY, PRIVATE_KEY);
  assert.equal(f.probes[0].options.verifyKey, true);
  const server = (await f.registry.runtimeServers())[0];
  assert.deepEqual(server.enabledTools, KCSC_QUERY_TOOLS);
  assert.equal(server.env.KCSC_DOMAIN, '전체');
  assert.equal(server.env.KCSC_API_KEY, PRIVATE_KEY);
  assert.equal(JSON.stringify(result).includes(PRIVATE_KEY), false);
  assert.equal((await readFile(join(f.dataDir, 'external-mcp.json'), 'utf8')).includes(PRIVATE_KEY), false);
  await f.connection.test({});
  assert.equal(f.probes.length, 2);
  assert.equal(f.installs(), 1);
});

test('KCSC accepts the same printable private-key format as its local credential form', async t => {
  const f = await fixture(t);
  const key = `${PRIVATE_KEY}+/=`;
  await f.connection.save({ apiKey: key, trusted: true });
  assert.equal((await f.registry.runtimeServers())[0].env.KCSC_API_KEY, key);
});

test('a failed key replacement preserves the original encrypted connection and sanitizes errors', async t => {
  const f = await fixture(t);
  await f.connection.save({ apiKey: PRIVATE_KEY, trusted: true });
  f.setFailing(true);
  await assert.rejects(f.connection.save({ apiKey: REPLACEMENT_KEY, trusted: true }), error => !error.message.includes(PRIVATE_KEY) && /키|KCSC/.test(error.message));
  assert.equal((await f.registry.runtimeServers())[0].env.KCSC_API_KEY, PRIVATE_KEY);
  assert.equal((await f.connection.status()).connected, false);
  assert.equal(JSON.stringify(await f.connection.status()).includes(PRIVATE_KEY), false);
});

test('removing KCSC preserves other registered MCPs and secrets', async t => {
  const f = await fixture(t);
  await f.registry.upsert({ name: 'other', transport: 'stdio', command: process.execPath, env: { OTHER_KEY: PRIVATE_KEY } });
  await f.connection.save({ apiKey: PRIVATE_KEY, trusted: true });
  const result = await f.connection.remove({});
  assert.equal(result.configured, false); assert.equal(result.connected, false); assert.equal(result.installed, true);
  const remaining = await f.registry.runtimeServers();
  assert.equal(remaining.length, 1); assert.equal(remaining[0].name, 'other');
  assert.equal(remaining[0].env.OTHER_KEY, PRIVATE_KEY);
});

test('changing a registered KCSC key or tool policy invalidates previous verification without reading secrets', async t => {
  const f = await fixture(t);
  await f.connection.save({ apiKey: PRIVATE_KEY, trusted: true });
  const server = (await f.registry.runtimeServers())[0];
  await f.registry.upsert({ ...server, env: { ...server.env, KCSC_API_KEY: REPLACEMENT_KEY } });
  assert.equal((await f.connection.status()).connected, false);
  assert.equal((await f.connection.status()).count, 0);
  await f.connection.test({});
  assert.equal((await f.connection.status()).connected, true);
  await f.registry.upsert({ ...server, enabledTools: [] });
  assert.equal((await f.connection.status()).connected, false);
  await assert.rejects(f.connection.test({}), /기준 조회/);
  assert.equal((await f.connection.status()).connected, false);
});

test('KCSC bootstrap targets are fixed official hashed assets for supported macOS and Windows machines', () => {
  const hashes = new Set();
  for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
    const target = kcscTarget({ platform, arch });
    assert.match(target.url, /^https:\/\/files\.pythonhosted\.org\/packages\//);
    assert.match(target.sha256, /^[a-f0-9]{64}$/); hashes.add(target.sha256);
    assert.equal(target.member, `uv-0.8.22.data/scripts/uv${platform === 'win32' ? '.exe' : ''}`);
  }
  assert.equal(hashes.size, 4);
  assert.throws(() => kcscTarget({ platform: 'linux', arch: 'x64' }));
});
