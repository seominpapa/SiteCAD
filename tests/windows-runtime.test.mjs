import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess, runtimeConfig } from '../lib/codex-runtime.mjs';
import { isolatedProcessEnv } from '../lib/mcp-launcher.mjs';
import { createNodeSecretStores } from '../lib/node-secret-store.mjs';
import { CODEX_VERSION, installCodex } from '../scripts/install-codex.mjs';
import { startLocalWeb } from '../local-web.mjs';
import { cadFont } from '../server.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 600000 };
const root = fileURLToPath(new URL('../', import.meta.url));
const mcpPath = join(root, 'lib', 'sitecad-mcp.mjs');

test('Windows local web launcher serves protected editor/font assets and authenticates a real internal MCP', windows, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-windows-web-'));
  const dataDir = join(directory, '한글 폴더 SiteCAD');
  const bridgeToken = randomBytes(32).toString('hex');
  const context = { documentId: 7, revision: 2, units: 4, selection: [], entities: [] };
  const opened = []; let starts = 0; let closes = 0; let probes = 0; let instance; let rpc;
  const controller = {
    start: async () => { starts++; }, close: async () => { closes++; },
    status: async () => ({ oauth: { connected: false }, runtime: { connected: false } }),
    authorizeMcp: value => value === `Bearer ${bridgeToken}`,
    callCad: async method => { assert.equal(method, 'context'); probes++; return context; },
  };
  try {
    instance = await startLocalWeb({ dataDir, codexPath: process.execPath, openBrowser: async url => opened.push(url),
      controllerFactory: async () => controller, installSignalHandlers: false });
    assert.equal(starts, 1);
    const landing = await fetch(instance.baseUrl);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /이 브라우저로 연결/);
    assert.equal((await fetch(`${instance.baseUrl}/api/desktop/status`)).status, 403);
    const launch = await fetch(opened[0], { redirect: 'manual' });
    assert.equal(launch.status, 303);
    const cookie = launch.headers.get('set-cookie').split(';')[0];
    let ownerToken;
    const request = (path, options = {}) => fetch(`${instance.baseUrl}${path}`, { ...options, headers: { Cookie: cookie, ...(ownerToken ? { 'X-SiteCAD-Owner': ownerToken } : {}), ...options.headers } });
    assert.match(await (await request('/')).text(), /<title>SiteCAD/);
    assert.match(await (await request('/app/')).text(), /Open CAD Studio/);
    const claim = await request('/api/browser/claim', { method: 'POST', headers: { Origin: instance.baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: randomUUID() }) });
    assert.equal(claim.status, 200);
    ownerToken = (await claim.json()).data.ownerToken;
    assert.match(ownerToken, /^[a-f0-9]{64}$/);
    const health = await (await request('/api/health')).json();
    assert.equal(health.data.browser, true); assert.equal(health.data.editorInstalled, true);
    const font = await request('/api/cad-font');
    assert.equal(font.status, 200); assert.equal(font.headers.get('X-SiteCAD-CAD-Font'), 'malgun.ttf');
    assert.equal(font.headers.get('content-type'), 'font/ttf');
    const installedFont = cadFont();
    assert.deepEqual(Buffer.from(await font.arrayBuffer()), await readFile(join(installedFont.directory, installedFont.name)));
    const head = await request('/api/cad-font', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await request('/api/cad-font/malgun.ttf')).status, 404);
    assert.equal((await fetch(`${instance.baseUrl}/api/internal/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"context","payload":{}}' })).status, 403);
    rpc = new JsonRpcProcess(spawn(process.execPath, [mcpPath], { cwd: dataDir,
      env: { ...isolatedProcessEnv(dataDir, process.execPath), SITECAD_BRIDGE_URL: instance.baseUrl, SITECAD_BRIDGE_TOKEN: bridgeToken },
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sitecad-windows-web-test', version: '1' } });
    const inventory = await rpc.request('tools/list', {});
    assert.ok(inventory.tools.some(tool => tool.name === 'cad_context'));
    const result = await rpc.request('tools/call', { name: 'cad_context', arguments: {} });
    assert.deepEqual(result.structuredContent, context); assert.equal(probes, 1);
    const reused = await startLocalWeb({ dataDir, installSignalHandlers: false });
    assert.equal(reused.reused, true); assert.equal(reused.baseUrl, instance.baseUrl); assert.equal(starts, 1);
    await rpc.stop(); rpc = undefined;
    await instance.close(); assert.equal(closes, 1);
    await assert.rejects(readFile(join(dataDir, 'local-web-runtime.json')), { code: 'ENOENT' });
    t.diagnostic('Native launcher/named-pipe reuse, browser session, actual editor assets, Malgun font and real authenticated MCP transport passed with a fixture drawing controller.');
  } finally { await rpc?.stop(); await instance?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Windows native Credential Manager and encrypted SiteCAD stores persist without plaintext secrets', windows, async t => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const entry = new AsyncEntry('SiteCAD Windows CI', randomUUID());
  const secret = randomBytes(32).toString('hex');
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-windows-credentials-'));
  const master = new AsyncEntry('SiteCAD Web', createHash('sha256').update(dataDir).digest('hex'));
  try {
    assert.equal(await entry.getPassword(), null);
    await entry.setPassword(secret);
    assert.equal(await entry.getPassword(), secret);
    assert.equal(await entry.deletePassword(), true);
    assert.equal(await entry.getPassword(), null);
    const stores = createNodeSecretStores({ dataDir });
    await stores.auth.write({ syntheticTestToken: secret });
    assert.equal((await readFile(join(dataDir, 'credentials.enc'))).includes(Buffer.from(secret)), false);
    assert.deepEqual(await createNodeSecretStores({ dataDir }).auth.read(), { syntheticTestToken: secret });
    t.diagnostic('Windows Credential Manager write/read/delete and AES-GCM restart restore passed; no real account used.');
  } finally {
    await entry.deletePassword();
    await master.deletePassword();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Windows official Codex app-server discovers and invokes the internal SiteCAD MCP without ChatGPT credentials', windows, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-windows-codex-'));
  const codexHome = join(directory, 'codex-home');
  const workspace = join(directory, 'workspace');
  const bridgeToken = randomBytes(32).toString('hex');
  const context = { documentId: 1, revision: 0, units: 4, selection: [], entities: [] };
  let probes = 0; let rpc;
  const bridge = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/internal/mcp' || req.headers.authorization !== `Bearer ${bridgeToken}`) { res.writeHead(403); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method !== 'context') { res.writeHead(400); res.end(); return; }
    probes++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: context }));
  });
  try {
    await Promise.all([mkdir(codexHome), mkdir(workspace)]);
    const binary = await installCodex({ destination: join(directory, 'runtime') });
    assert.ok(binary.endsWith('codex.exe'));
    await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
    const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
    await writeFile(join(codexHome, 'config.toml'), runtimeConfig({ workspace, nodePath: process.execPath, mcpPath, modelCatalogPath: join(root, 'codex-models.json') }));
    const env = { ...isolatedProcessEnv(codexHome, process.execPath), CODEX_HOME: codexHome, ACCESS_TOKEN: 'sitecad-ci-synthetic-no-account', SITECAD_BRIDGE_URL: bridgeUrl, SITECAD_BRIDGE_TOKEN: bridgeToken };
    rpc = new JsonRpcProcess(spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    const initialized = await rpc.request('initialize', { clientInfo: { name: 'sitecad-windows-test', version: '1' }, capabilities: { experimentalApi: true } });
    assert.ok(initialized);
    rpc.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const started = await rpc.request('thread/start', { cwd: workspace, model: 'gpt-6.1-sol', modelProvider: 'openai_chatgpt_plan', approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: true });
    assert.ok(started.thread?.id);
    const threadId = started.thread.id;
    let server;
    for (let attempt = 0; attempt < 60; attempt++) {
      const inventory = await rpc.request('mcpServerStatus/list', { threadId, limit: 100, detail: 'toolsAndAuthOnly' });
      server = inventory.data.find(item => item.name === 'sitecad');
      if (server?.tools?.cad_context) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(server?.tools?.cad_context, 'Codex must discover the actual internal SiteCAD MCP');
    const result = await rpc.request('mcpServer/tool/call', { threadId, server: 'sitecad', tool: 'cad_context', arguments: {} }, 65000);
    assert.notEqual(result.isError, true);
    const data = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.deepEqual(data, context);
    assert.ok(probes > 0);
    t.diagnostic(`Official Codex ${CODEX_VERSION} initialized and invoked real SiteCAD MCP over an authenticated local bridge. No model inference/login claimed.`);
  } finally {
    await rpc?.stop();
    await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
