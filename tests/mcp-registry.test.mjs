import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpRegistry } from '../lib/mcp-registry.mjs';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-registry-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let saved = null;
  const secretStore = { read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } };
  const config = { dataDir, nodePath: '/Applications/SiteCAD.app/Contents/MacOS/SiteCAD', nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, secretStore, reaSource: '/Applications/SiteCAD.app/Contents/Resources/app/rea', ...options };
  return { dataDir, config, registry: await createMcpRegistry(config), secrets: () => saved };
}

const stdio = { name: 'example', transport: 'stdio', command: '/usr/local/bin/example', args: ['mcp'] };

test('MCP entries persist privately and safe listings are independent copies', async t => {
  const { registry, dataDir, config } = await setup(t);
  assert.deepEqual(await registry.list(), []);
  await registry.upsert(stdio);
  assert.equal((await stat(join(dataDir, 'external-mcp.json'))).mode & 0o777, 0o600);
  const list = await registry.list();
  list[0].args.push('changed');
  assert.deepEqual((await registry.list())[0].args, ['mcp']);
  assert.deepEqual(await (await createMcpRegistry(config)).list(), await registry.list());
  assert.equal((await registry.runtimeServers())[0].command, stdio.command);
});

test('environment and bearer secrets stay encrypted and safe listings never disclose them', async t => {
  const { registry, dataDir, secrets } = await setup(t);
  await registry.upsert({ ...stdio, env: { SERVICE_KEY: 'private-env-value' } });
  await registry.upsert({ name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', bearerToken: 'private-bearer' });
  const text = await readFile(join(dataDir, 'external-mcp.json'), 'utf8');
  assert.equal(text.includes('private-'), false);
  const safe = JSON.stringify(await registry.list());
  assert.equal(safe.includes('private-'), false);
  assert.ok(safe.includes('SERVICE_KEY'));
  assert.ok(JSON.stringify(secrets()).includes('private-bearer'));
  const runtime = await registry.runtimeServers();
  assert.deepEqual(runtime[0].env, { SERVICE_KEY: 'private-env-value' });
  assert.equal(runtime[1].bearerToken, 'private-bearer');
  await registry.upsert({ name: 'remote', transport: 'http', url: 'https://new.example.com/mcp' });
  assert.equal((await registry.runtimeServers())[1].bearerToken, undefined);
});

test('same-endpoint updates preserve omitted secrets while explicit empty values clear them', async t => {
  const { registry } = await setup(t);
  const remote = { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp' };
  await registry.upsert({ ...remote, bearerToken: 'private-bearer' });
  await registry.upsert({ ...remote, enabledTools: ['search'] });
  assert.equal((await registry.runtimeServers())[0].bearerToken, 'private-bearer');
  await registry.upsert({ ...remote, bearerToken: '' });
  assert.equal((await registry.runtimeServers())[0].bearerToken, undefined);
  await registry.upsert({ ...stdio, env: { KEY: 'value' } });
  await registry.upsert({ ...stdio, args: ['mcp', '--safe'] });
  assert.deepEqual((await registry.runtimeServers())[1].env, {});
  await registry.upsert({ ...stdio, env: { KEY: 'value' } });
  await registry.upsert({ ...stdio, env: {} });
  assert.deepEqual((await registry.runtimeServers())[1].env, {});
});

test('registry validates names, absolute commands, schema, environment, tools and endpoint credentials', async t => {
  const { registry } = await setup(t);
  const invalid = [
    { ...stdio, name: 'sitecad' }, { ...stdio, name: 'research' }, { ...stdio, name: '__proto__' },
    { ...stdio, command: 'npx' }, { ...stdio, args: 'mcp' }, { ...stdio, args: ['\0'] },
    { ...stdio, enabledTools: ['bad tool'] }, { ...stdio, enabledTools: ['x', 'x'] },
    { ...stdio, unknown: true }, { ...stdio, env: { HOME: '/tmp' } },
    ...['ACCESS_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'PATH', 'DYLD_INSERT_LIBRARIES', 'SITECAD_BRIDGE_TOKEN', 'ELECTRON_RUN_AS_NODE'].map(key => ({ ...stdio, env: { [key]: 'bad' } })),
    ...['http://remote.example.com/mcp', 'file:///tmp/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?key=secret', 'https://example.com/mcp#token'].map(url => ({ name: 'remote', transport: 'http', url })),
    { name: 'remote', transport: 'http', url: 'https://example.com/mcp', bearerToken: 'bad\r\ntoken' },
    { name: 'remote', transport: 'http', url: 'https://example.com/mcp', command: '/bin/sh' },
  ];
  for (const input of invalid) await assert.rejects(registry.upsert(input), /MCP/);
  assert.deepEqual(await registry.list(), []);
  for (const [i, url] of ['http://127.0.0.1:3000/mcp', 'http://localhost:3001/mcp', 'http://[::1]:3002/mcp'].entries()) await registry.upsert({ name: `local${i}`, transport: 'http', url });
});

test('REA preset uses the bundled Node runtime without executing or inheriting ambient credentials', async t => {
  const { registry, config } = await setup(t);
  await registry.upsert({ name: 'rea', preset: 'rea', enabledTools: ['inspect_web_page'] });
  const [server] = await registry.runtimeServers();
  assert.equal(server.command, config.nodePath);
  assert.deepEqual(server.args, [join(config.reaSource, 'scripts/rea.mjs'), 'mcp']);
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal((await registry.list())[0].preset, 'rea');
  await assert.rejects(registry.upsert({ name: 'rea', preset: 'unknown' }), /MCP/);
});

test('removal erases stored credentials and simultaneous additions cannot bypass the eight-server limit', async t => {
  const { registry, secrets } = await setup(t);
  await registry.upsert({ ...stdio, env: { KEY: 'remove-me' } });
  await registry.remove('example');
  assert.deepEqual(await registry.list(), []);
  assert.equal(JSON.stringify(secrets()).includes('remove-me'), false);
  await registry.remove('example');
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => registry.upsert({ ...stdio, name: `mcp${i}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal((await registry.list()).length, 8);
  await assert.rejects(registry.remove('sitecad'), /MCP/);
});

test('malformed persisted configs and unavailable secret stores fail closed with safe errors', async t => {
  const { dataDir, config, registry } = await setup(t, { secretStore: undefined });
  await registry.upsert(stdio);
  await assert.rejects(registry.upsert({ ...stdio, env: { KEY: 'do-not-leak' } }), /MCP/);
  await writeFile(join(dataDir, 'external-mcp.json'), '{broken secret');
  await assert.rejects(createMcpRegistry(config), error => /MCP/.test(error.message) && !error.message.includes('secret'));
  await writeFile(join(dataDir, 'external-mcp.json'), JSON.stringify({ version: 1, servers: [{ ...stdio, envKeys: ['KEY'], secretRef: '00000000-0000-0000-0000-000000000000' }] }));
  const restored = await createMcpRegistry(config);
  await assert.rejects(restored.runtimeServers(), /MCP/);
});

test('disabled entries stay persisted but are never exposed as runtime servers', async t => {
  const { registry, config } = await setup(t);
  await registry.upsert({ ...stdio, enabled: false, env: { KEY: 'disabled-secret' } });
  assert.equal((await registry.list())[0].enabled, false);
  assert.deepEqual(await registry.runtimeServers(), []);
  assert.deepEqual(await (await createMcpRegistry({ ...config, secretStore: undefined })).runtimeServers(), []);
  await registry.upsert({ ...stdio, enabled: true });
  assert.equal((await registry.runtimeServers())[0].env.KEY, 'disabled-secret');
});

test('invalid persisted names, metadata and encrypted records cannot become runtime config', async t => {
  const { registry, dataDir, config } = await setup(t);
  await registry.upsert({ ...stdio, env: { KEY: 'secret' } });
  const broken = await createMcpRegistry({ ...config, secretStore: { read: async () => ({ records: {} }), write: async () => {} } });
  await assert.rejects(broken.runtimeServers(), /MCP/);
  const base = { version: 1, servers: [stdio] };
  for (const value of [{ ...base, version: 2 }, { ...base, servers: [stdio, stdio] }, { ...base, servers: [{ ...stdio, hasBearerToken: true }] }, { ...base, servers: [{ ...stdio, enabled: 'true' }] }]) {
    await writeFile(join(dataDir, 'external-mcp.json'), JSON.stringify(value));
    await assert.rejects(createMcpRegistry(config), /MCP/);
  }
  await assert.rejects(createMcpRegistry({ ...config, dataDir: 'relative' }), /MCP/);
  const { registry: unavailable } = await setup(t, { reaSource: undefined });
  await assert.rejects(unavailable.upsert({ name: 'rea', preset: 'rea' }), /MCP/);
});
