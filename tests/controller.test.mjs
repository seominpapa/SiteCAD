import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const context = { documentId: 2, revision: 1, units: 4, selection: [], entities: [] };
async function setup(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-controller-'));
  let options;
  let stopped = 0;
  const auth = { status: () => ({ loggedIn: true, sharing: true, pending: false }), getAccessToken: async () => 'private-token', login: async () => ({ pending: true }), logout: async () => {}, close: async () => {} };
  const runtime = { start: async () => {}, chat: async () => ({ reply: '완료' }), status: () => ({ connected: true }), cancel: async () => {}, stop: async () => { stopped++; } };
  const controller = await createDesktopController({ dataDir, codexPath: '/app/codex', nodePath: '/app/node', secureStore: {}, openExternal: async () => {}, authFactory: async () => auth, runtimeFactory: async value => { options = value; return runtime; }, bridgeTimeoutMs: 40, ...overrides });
  await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
  return { controller, dataDir, runtime, auth, options: () => options, stopped: () => stopped, close: async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
async function duringTurn(t, action, cancelled = false) {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  t.runtime.chat = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { reply: '완료' }; };
  const turn = t.controller.chat({ message: '도면 작업', context, history: [] });
  const completed = cancelled ? assert.rejects(turn, /취소/) : turn;
  await started;
  try { return await action(); } finally {
    release();
    await new Promise(resolve => setImmediate(resolve));
    const verification = await t.controller.pollCad({ waitMs: 0 });
    if (verification) {
      assert.equal(verification.method, 'completion_state');
      t.controller.completeCad(verification.id, { documentId: context.documentId, units: context.units, command: null, modal: null, textEditor: null, mtextEditor: null });
    }
    await completed;
  }
}
test('isolates runtime configuration and never exposes tokens through status', async () => {
  const t = await setup();
  try {
    const result = await t.controller.chat({ message: '사각형', context, history: [] });
    assert.equal(result.executed, true);
    assert.equal(t.options().codexHome, join(t.dataDir, 'codex-home'));
    assert.equal(t.options().workspace, join(t.dataDir, 'workspace'));
    assert.equal(t.options().bridgeUrl, 'http://127.0.0.1:4318');
    assert.doesNotMatch(JSON.stringify(await t.controller.status()), /private-token|bridgeToken/);
  } finally { await t.close(); }
});
test('CAD bridge validates operations before dispatch and requires expected document context', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.controller.callCad('execute', { operations: [{ type: 'undo' }], expectedContext: context }), /진행/);
    await duringTurn(t, async () => {
    await assert.rejects(t.controller.callCad('execute', { operations: [{ type: 'exec', command: 'rm' }], expectedContext: context }));
    await assert.rejects(t.controller.callCad('execute', { operations: [{ type: 'undo' }] }), /도면/);
    const request = t.controller.callCad('execute', { operations: [{ type: 'undo' }], expectedContext: context });
    const job = await t.controller.pollCad();
    assert.equal(job.method, 'execute');
    t.controller.completeCad(job.id, { details: ['되돌림'], context });
    assert.deepEqual((await request).details, ['되돌림']);
    assert.throws(() => t.controller.completeCad(job.id, {}), /만료/);
    });
  } finally { await t.close(); }
});
test('DWG saving is confined, verifies bytes, and never overwrites an existing file', async () => {
  const t = await setup();
  try {
    await duringTurn(t, async () => {
    await assert.rejects(t.controller.callCad('save', { name: '../escape.dwg', expectedContext: context }));
    const bytes = Buffer.from('AC1032verified-dwg');
    const save = async () => {
      const promise = t.controller.callCad('save', { name: 'drawing.dwg', expectedContext: context });
      const job = await t.controller.pollCad();
      t.controller.completeCad(job.id, { name: 'drawing.dwg', dataBase64: bytes.toString('base64'), version: 'AC1032', audit: { errors: 0, droppedOnSave: 0 }, context });
      return promise;
    };
    const first = await save(); const second = await save();
    assert.notEqual(first.path, second.path);
    assert.equal(first.bytes, bytes.length);
    assert.deepEqual(await readFile(first.path), bytes);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.path.startsWith(join(t.dataDir, 'Drawings') + '/'), true);
    });
  } finally { await t.close(); }
});
test('timeouts and cancellation reject pending work instead of leaving hanging MCP calls', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.controller.callCad('context', {}), /시간/);
    const pending = t.controller.callCad('context', {});
    const rejected = assert.rejects(pending, /취소/);
    await t.controller.cancel(); await rejected;
    assert.equal(await t.controller.pollCad({ waitMs: 1 }), null);
  } finally { await t.close(); }
});

test('cancelling runtime startup prevents a late chat from changing the drawing', async () => {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let chats = 0; let stops = 0;
  const t = await setup({ runtimeFactory: async () => ({
    start: async () => { entered(); await new Promise(resolve => { release = resolve; }); },
    chat: async () => { chats++; return { reply: '실행됨' }; }, status: () => ({}),
    cancel: async () => {}, stop: async () => { stops++; }
  }) });
  try {
    const pending = t.controller.chat({ message: '사각형', context, history: [] });
    const rejected = assert.rejects(pending, /취소/);
    await started; await t.controller.cancel(); release(); await rejected;
    assert.equal(chats, 0); assert.ok(stops > 0);
  } finally { release?.(); await t.close(); }
});

test('cancellation immediately rejects new edits while the runtime is still stopping', async () => {
  const t = await setup();
  let release;
  t.runtime.cancel = () => new Promise(resolve => { release = resolve; });
  try {
    await duringTurn(t, async () => {
      const cancelling = t.controller.cancel();
      try {
        await assert.rejects(t.controller.callCad('execute', {
          operations: [{ type: 'undo' }], expectedContext: context,
        }), /진행/);
      } finally { release(); await cancelling; }
    }, true);
  } finally { await t.close(); }
});

test('a failed model turn discards queued edits before another browser poll', async () => {
  const t = await setup();
  let fail;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  t.runtime.chat = () => new Promise((_, reject) => { fail = reject; entered(); });
  try {
    const turn = t.controller.chat({ message: '도면 작업', context, history: [] });
    const failed = assert.rejects(turn, /모델/);
    await started;
    const pending = t.controller.callCad('execute', { operations: [{ type: 'undo' }], expectedContext: context });
    const discarded = assert.rejects(pending, /종료/);
    fail(Error('모델 연결 실패'));
    await failed; await discarded;
    assert.equal(await t.controller.pollCad({ waitMs: 0 }), null);
  } finally { await t.close(); }
});

test('external MCP changes require explicit trust, are isolated and reset idle runtime', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.controller.mcpSave({ config: { name: 'sample', transport: 'stdio', command: '/app/tool' } }), /신뢰/);
    const result = await t.controller.mcpSave({ trusted: true, config: { mcpServers: { sample: { command: '/app/tool', args: [] } } } });
    assert.equal(result.servers[0].name, 'sample');
    await t.controller.chat({ message: '확인', context, history: [] });
    assert.equal(t.options().externalServers[0].command, '/app/tool');
    await t.controller.mcpToggle({ name: 'sample', enabled: false });
    assert.equal(t.stopped(), 1);
    assert.equal((await t.controller.mcpList()).servers[0].enabled, false);
    await t.controller.mcpRemove({ name: 'sample' });
    assert.deepEqual((await t.controller.mcpList()).servers, []);
  } finally { await t.close(); }
});

test('research provenance comes from actual fetches and external approvals are single-use', async () => {
  const t = await setup({ webReference: { fetchDocument: async ({ url }) => ({ url, title: '기준', content: '자료', sha256: 'a'.repeat(64), untrusted: true }) } });
  try {
    await assert.rejects(t.controller.callCad('fetch', { url: 'https://example.org' }), /진행/);
    await duringTurn(t, async () => {
      const source = await t.controller.callCad('fetch', { url: 'https://example.org' });
      assert.equal(source.content, '자료');
      const approval = t.options().onApproval({ server: 'sample', tool: 'read', arguments: { url: source.url } });
      const status = await t.controller.status();
      assert.equal(status.approvals.length, 1);
      t.controller.resolveApproval({ id: status.approvals[0].id, approved: true });
      assert.equal(await approval, 'approve');
      assert.throws(() => t.controller.resolveApproval({ id: status.approvals[0].id, approved: true }), /만료/);
      await assert.rejects(t.controller.mcpSave({ trusted: true, config: { name: 'a', transport: 'stdio', command: '/bin/a' } }), /작업/);
    });
  } finally { await t.close(); }
});

test('standard HTTP bearer headers are stored privately and connection checks report actual inventory', async () => {
  let stored = null;
  const t = await setup({ mcpSecretStore: { read: async () => stored, write: async value => { stored = value; } } });
  t.runtime.getMcpStatus = async () => [{ name: 'remote', status: 'connected', tools: ['search'] }];
  t.runtime.testExternal = async name => ({ name, tested: true, status: 'connected', tools: ['search'] });
  try {
    await t.controller.mcpSave({ trusted: true, config: { mcpServers: { remote: { url: 'https://example.org/mcp', headers: { Authorization: 'Bearer test-private-key' } } } } });
    assert.doesNotMatch(JSON.stringify(await t.controller.mcpList()), /test-private-key/);
    assert.equal((await t.controller.mcpTest({ name: 'remote' })).tested, true);
    assert.equal((await t.controller.mcpList()).servers[0].connected, true);
    assert.equal(t.options().externalServers[0].bearerToken, 'test-private-key');
    await t.controller.mcpToggle({ name: 'remote', enabled: false });
    assert.equal((await t.controller.mcpList()).servers[0].enabled, false);
    await assert.rejects(t.controller.mcpTest({ name: 'remote' }));
    for (const headers of [{ Cookie: 'private' }, { Authorization: 'Basic private' }, {}]) {
      await assert.rejects(t.controller.mcpSave({ trusted: true, config: { name: 'remote', transport: 'http', url: 'https://example.org', headers } }));
    }
    await assert.rejects(t.controller.mcpSave({ trusted: true, config: { mcpServers: { a: {}, b: {} } } }));
  } finally { await t.close(); }
});

test('reference credentials stay out of model configuration and VWorld calls require an active chat', async () => {
  let saved = null; let apiCalls = 0;
  const key = 'controller-private-vworld-1234';
  const t = await setup({ referenceSecretStore: { read: async () => saved, write: async value => { saved = value; }, remove: async () => { saved = null; } },
    referenceApiFactory: ({ readCredentials }) => ({
      geocode: async () => { assert.equal((await readCredentials()).apiKey, key); apiCalls++; return { point: { x: 126.9784, y: 37.5667 }, crs: 'EPSG:4326', sourceUrl: 'https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do' }; },
      parcels: async () => ({ type: 'FeatureCollection', features: [], count: 0, crs: 'EPSG:4326', sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral' }),
    }),
  });
  try {
    assert.equal((await t.controller.referencesStatus()).vworld.configured, false);
    assert.equal((await t.controller.referencesSave({ apiKey: key })).vworld.configured, true);
    assert.equal(apiCalls, 0);
    await assert.rejects(t.controller.callCad('geocode', { address: '서울 중구' }), /진행/);
    assert.equal((await t.controller.referencesTest()).ok, true);
    t.runtime.chat = async () => {
      await assert.rejects(t.controller.referencesSave({ apiKey: key }), /작업/);
      await assert.rejects(t.controller.referencesRemove(), /작업/);
      await assert.rejects(t.controller.referencesTest(), /작업/);
      await t.controller.callCad('geocode', { address: '서울 중구' });
      await t.controller.callCad('parcels', { bbox: [126.978, 37.566, 126.979, 37.567] });
      return { reply: '조회만 완료' };
    };
    const result = await t.controller.chat({ message: '서울 중구 좌표 조회', context, history: [] });
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].kind, 'geodata');
    assert.equal(result.sources[1].count, 0);
    assert.equal(result.sources[1].features, undefined);
    assert.doesNotMatch(JSON.stringify({ status: await t.controller.referencesStatus(), model: t.options(), result }), /controller-private-vworld/);
    await t.controller.referencesRemove();
    assert.equal(saved, null);
    assert.equal((await t.controller.referencesStatus()).vworld.configured, false);
  } finally { await t.close(); }
});

const parcelData = { type: 'FeatureCollection', crs: 'EPSG:4326', bbox: [126.978, 37.5665, 126.979, 37.5675], count: 1, possiblyTruncated: false,
  sourceUrl: 'https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral', retrievedAt: '2026-10-22T10:00:00Z',
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[126.978, 37.5665], [126.979, 37.5665], [126.979, 37.5675], [126.978, 37.5675], [126.978, 37.5665]]] }, properties: { pnu: '111101' } }] };
test('parcel bridge projects only cached real data, checks the anchor, and persists a hash-bound DWG sidecar', async () => {
  const t = await setup({ bridgeTimeoutMs: 1000, referenceApiFactory: () => ({ parcels: async () => parcelData }) });
  try {
    await assert.rejects(t.controller.callCad('insert_parcels', { sourceId: 'invented', expectedContext: context }), /진행/);
    await duringTurn(t, async () => {
      await assert.rejects(t.controller.callCad('insert_parcels', { sourceId: 'invented', expectedContext: context }), /출처/);
      const source = await t.controller.callCad('parcels', { bbox: parcelData.bbox });
      await assert.rejects(t.controller.callCad('insert_parcels', { sourceId: source.id, expectedContext: context, geometry: [] }));
      const pending = t.controller.callCad('insert_parcels', { sourceId: source.id, expectedContext: context });
      const read = await t.controller.pollCad();
      assert.equal(read.method, 'parcel_context');
      t.controller.completeCad(read.id, { georeference: null, context });
      const insert = await t.controller.pollCad();
      assert.equal(insert.method, 'insert_parcels');
      const { metadata, rings } = insert.payload.plan;
      assert.equal(rings.length, 1);
      assert.equal(metadata.targetCRS, 'EPSG:5179');
      assert.equal(metadata.sourceId, source.id);
      assert.equal(metadata.modelScale, 1);
      assert(rings[0].verticesMm.every(([x, y]) => Math.abs(x) < 100000 && Math.abs(y) < 100000));
      const next = { ...context, revision: 2 };
      t.controller.completeCad(insert.id, { message: '필지 삽입', details: ['1개 필지'], georeference: metadata, summary: insert.payload.plan.summary, context: next });
      assert.equal((await pending).georeference.sourceId, source.id);
      await assert.rejects(t.controller.callCad('insert_parcels', { sourceId: source.id, expectedContext: next }), /이미/);
      const save = t.controller.callCad('save', { name: 'parcel.dwg', expectedContext: next });
      const job = await t.controller.pollCad();
      t.controller.completeCad(job.id, { dataBase64: Buffer.from('AC1032parcel').toString('base64'), version: 'AC1032', audit: { errors: 0, droppedOnSave: 0 }, georeferences: [metadata], context: next });
      const saved = await save;
      const sidecar = JSON.parse(await readFile(saved.metadataPath, 'utf8'));
      assert.equal(sidecar.dwgSha256, saved.sha256);
      assert.deepEqual(sidecar.georeferences, [metadata]);
    });
    await duringTurn(t, async () => { await assert.rejects(t.controller.callCad('insert_parcels', { sourceId: 'geo-old', expectedContext: context }), /출처/); });
  } finally { await t.close(); }
});

test('cancelled parcel context never dispatches a late drawing insertion', async () => {
  const t = await setup({ referenceApiFactory: () => ({ parcels: async () => parcelData }) });
  try {
    await duringTurn(t, async () => {
      const source = await t.controller.callCad('parcels', {});
      const pending = t.controller.callCad('insert_parcels', { sourceId: source.id, expectedContext: context });
      const rejected = assert.rejects(pending, /취소/);
      const read = await t.controller.pollCad();
      assert.equal(read.method, 'parcel_context');
      await t.controller.cancel(); await rejected;
      assert.equal(await t.controller.pollCad({ waitMs: 0 }), null);
    }, true);
  } finally { await t.close(); }
});

test('terrain bridge requires real cached data, shares the parcel anchor, and saves actual terrain metadata', async () => {
  const { projectParcels } = await import('../lib/parcel-projection.mjs');
  const anchor = projectParcels({ ...parcelData, id: 'geo-parcel' }, { units: 4 }).metadata;
  const terrain = { ...parcelData, originalCRS: 'EPSG:4326', verticalDatum: 'unknown', sourceKind: 'local-file', sourceSha256: 'c'.repeat(64),
    sourceUrl: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30185', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[126.978, 37.5665], [126.979, 37.5675]] }, properties: { elevation_m: 42.5 } }] };
  const t = await setup({ bridgeTimeoutMs: 1000, terrainData: { list: async () => [{ id: 'terrain-test' }], query: async () => terrain, importFile: async () => ({ id: 'terrain-test' }) } });
  try {
    assert.equal((await t.controller.terrainStatus()).datasets[0].id, 'terrain-test');
    await assert.rejects(t.controller.callCad('terrain_query', { bbox: parcelData.bbox }), /진행/);
    await duringTurn(t, async () => {
      await assert.rejects(t.controller.terrainImport(), /작업/);
      await assert.rejects(t.controller.callCad('insert_terrain', { sourceId: 'invented', expectedContext: context }), /출처/);
      const source = await t.controller.callCad('terrain_query', { bbox: parcelData.bbox });
      const pending = t.controller.callCad('insert_terrain', { sourceId: source.id, expectedContext: context });
      const read = await t.controller.pollCad(); t.controller.completeCad(read.id, { georeference: anchor, context });
      const insert = await t.controller.pollCad(); assert.equal(insert.method, 'insert_terrain');
      const { metadata, entities } = insert.payload.plan;
      assert.deepEqual(metadata.originProjectedM, anchor.originProjectedM);
      assert.equal(entities[0].elevationM, 42.5); assert.equal(metadata.kind, 'terrain'); assert.equal(metadata.netAreaM2, null);
      const next = { ...context, revision: 2 };
      t.controller.completeCad(insert.id, { georeference: metadata, context: next }); await pending;
      await assert.rejects(t.controller.callCad('insert_terrain', { sourceId: source.id, expectedContext: next }), /이미/);
      const saving = t.controller.callCad('save', { name: 'terrain.dwg', expectedContext: next });
      const job = await t.controller.pollCad(); t.controller.completeCad(job.id, { dataBase64: Buffer.from('AC1032terrain').toString('base64'), version: 'AC1032', audit: { errors: 0, droppedOnSave: 0 }, georeferences: [anchor, metadata], context: next });
      const saved = await saving;
      assert.equal(JSON.parse(await readFile(saved.metadataPath, 'utf8')).georeferences[1].terrain.minElevationM, 42.5);
    });
  } finally { await t.close(); }
});

test('utility tools require an active turn, retain actual downloads and abort on cancellation', async () => {
  let signal; const downloads = [];
  const t = await setup({ agentUtilities: {
    calculate: value => ({ results: [{ name: 'area', value: value.variables.w * value.variables.h }] }),
    download: async (value, options) => { signal = options.signal; const result = { id: 'download-1', name: 'drawing.dxf', path: '/app/downloads/drawing.dxf', url: value.url, bytes: 20, sha256: 'a'.repeat(64), untrusted: true }; downloads.push(result); return result; },
  } });
  try {
    await assert.rejects(t.controller.callCad('calculate', { expressions: [] }), /진행/);
    let release; let entered; const started = new Promise(resolve => { entered = resolve; });
    t.runtime.chat = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { reply: '완료' }; };
    const turn = t.controller.chat({ message: '자료 내려받고 계산', context, history: [] }); await started;
    const calculation = await t.controller.callCad('calculate', { expressions: [{ name: 'area', expression: 'w*h' }], variables: { w: 3, h: 4 } });
    assert.equal(calculation.results[0].value, 12);
    await t.controller.callCad('download', { url: 'https://example.org/drawing.dxf' });
    await t.controller.cancel(); assert.equal(signal.aborted, true); release();
    await assert.rejects(turn, /취소/);
  } finally { await t.close(); }
});

test('terrain registration resolves only this turn successful download and passes the original trusted metadata', async () => {
  const download = { id: 'cfe66a1c-8a45-4dab-aed6-c294ec2fbd5f', name: 'contours.geojson', path: '/app/downloads/contours.geojson',
    url: 'https://example.org/contours.geojson', bytes: 200, sha256: 'b'.repeat(64), retrievedAt: '2026-10-23T00:00:00.000Z' };
  const calls = [];
  const t = await setup({ agentUtilities: { download: async () => download }, terrainData: {
    list: async () => [], registerDownload: async (metadata, { signal }) => { calls.push({ metadata, signal }); return { id: 'terrain-result', sourceKind: 'public-download' }; },
  } });
  try {
    await assert.rejects(t.controller.callCad('terrain_register', { downloadId: download.id }), /진행/);
    await duringTurn(t, async () => {
      await assert.rejects(t.controller.callCad('terrain_register', { downloadId: download.id }), /현재.*다운로드/);
      await t.controller.callCad('download', { url: download.url });
      for (const input of [{ downloadId: download.id, path: '/private/secret' }, { downloadId: '' }, { downloadId: 'made-up' }, null, []]) {
        await assert.rejects(t.controller.callCad('terrain_register', input));
      }
      assert.equal((await t.controller.callCad('terrain_register', { downloadId: download.id })).id, 'terrain-result');
      assert.deepEqual(calls[0].metadata, download);
      assert.equal(calls[0].signal.aborted, false);
    });
    assert.equal(calls[0].signal.aborted, true);
    await duringTurn(t, async () => {
      await assert.rejects(t.controller.callCad('terrain_register', { downloadId: download.id }), /현재.*다운로드/);
    });
    assert.equal(calls.length, 1);
  } finally { await t.close(); }
});

test('cancellation aborts pending terrain registration and rejects its late completion', async () => {
  let entered, release, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const id = 'cfe66a1c-8a45-4dab-aed6-c294ec2fbd5f';
  const t = await setup({ agentUtilities: { download: async () => ({ id }) }, terrainData: {
    list: async () => [], registerDownload: async (_, options) => { signal = options.signal; entered(); await new Promise(resolve => { release = resolve; }); return { id: 'terrain-late' }; },
  } });
  try {
    await duringTurn(t, async () => {
      await t.controller.callCad('download', { url: 'https://example.org/contours.geojson' });
      const pending = t.controller.callCad('terrain_register', { downloadId: id });
      const rejected = assert.rejects(pending, /취소/);
      await started; await t.controller.cancel(); assert.equal(signal.aborted, true); release(); await rejected;
    }, true);
  } finally { release?.(); await t.close(); }
});

test('generic CAD routes validate at the server and preserve revision and selection guards', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.controller.callCad('control', { request: { op: 'undo' }, expectedContext: context }), /진행/);
    await duringTurn(t, async () => {
      await assert.rejects(t.controller.callCad('control', { request: { op: 'save', path: '/tmp/bypass.dwg' }, expectedContext: context }));
      await assert.rejects(t.controller.callCad('query', { request: { op: 'state' }, expectedContext: { ...context, units: 6 } }), /단위/);
      for (const [method, request] of [['discover', { op: 'capabilities' }], ['query', { op: 'query', limit: 10 }], ['control', { op: 'undo' }]]) {
        const pending = t.controller.callCad(method, { request, ...(method === 'discover' ? {} : { expectedContext: context }) });
        const job = await t.controller.pollCad();
        assert.equal(job.method, method); assert.deepEqual(job.payload.request, request);
        assert.equal(t.controller.claimCad(job.id).valid,true);
        if (method !== 'discover') assert.deepEqual(job.payload.expectedContext.selection, context.selection);
        t.controller.completeCad(job.id, { result: { ok: true }, context });
        assert.equal((await pending).result.ok, true);
        assert.equal(t.controller.claimCad(job.id).valid,false);
      }
    });
  } finally { await t.close(); }
});

test('renderer job claims expire on timeout, turn completion and cancellation', async () => {
 const t=await setup();
 try {
  for(const id of [null,{},'x'.repeat(101)]) assert.equal(t.controller.claimCad(id).valid,false);
  await duringTurn(t,async()=>{
   const timed=t.controller.callCad('context',{});const expired=assert.rejects(timed,/시간/);
   const job=await t.controller.pollCad();assert.equal(t.controller.claimCad(job.id).valid,true);
   await expired;assert.equal(t.controller.claimCad(job.id).valid,false);
  });
  let completedId;
  await duringTurn(t,async()=>{
   const request=t.controller.callCad('context',{});const rejected=assert.rejects(request,/종료/);
   const job=await t.controller.pollCad();completedId=job.id;assert.equal(t.controller.claimCad(job.id).valid,true);
   void rejected;
  });
  assert.equal(t.controller.claimCad(completedId).valid,false);
  await duringTurn(t,async()=>{
   const request=t.controller.callCad('context',{});const rejected=assert.rejects(request,/취소/);
   const job=await t.controller.pollCad();await t.controller.cancel();await rejected;
   assert.equal(t.controller.claimCad(job.id).valid,false);
  },true);
 }finally{await t.close();}
});
