import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentUtilities } from '../lib/agent-utilities.mjs';
import { createDesktopController } from '../lib/desktop-controller.mjs';
import { createTerrainData } from '../lib/terrain-data.mjs';
import { createMcpHandler } from '../lib/sitecad-mcp.mjs';
import { researchTools } from '../lib/research-mcp.mjs';

test('download → register → query → project → guarded insert → save preserves genuine source bytes and provenance', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-terrain-download-'));
  const bbox = [126.978, 37.566, 126.980, 37.568];
  const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[126.9785, 37.5665, 42.5], [126.9795, 37.5675, 42.5]] }, properties: {} },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [126.979, 37.567, 43.25] }, properties: {} },
  ] }));
  const url = 'https://data.example.org/contours.geojson', finalUrl = 'https://cdn.example.org/contours.geojson';
  const visited = [];
  const agentUtilities = createAgentUtilities({ dataDir, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async target => {
      visited.push(target.href);
      return target.href === url ? new Response(null, { status: 302, headers: { location: finalUrl } })
        : new Response(bytes, { headers: { 'content-type': 'application/geo+json' } });
    } });
  let controller, context = { documentId: 2, revision: 1, units: 4, selection: [], entities: [] }, metadata, download, dataset;
  const steps = [];
  const runtime = { start: async () => {}, stop: async () => {}, cancel: async () => {}, status: () => ({}), chat: async () => {
    const handle = createMcpHandler((method, payload) => controller.callCad(method, payload), researchTools);
    const call = async (name, args) => {
      const result = await handle('tools/call', { name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result)); steps.push(name); return result.structuredContent;
    };
    download = await call('cad_download', { url });
    dataset = await call('cad_terrain_register', { downloadId: download.id });
    const source = await call('cad_terrain_query', { bbox, datasetId: dataset.id });
    assert.equal(source.sourceUrl, finalUrl); assert.equal(source.features[1].properties.elevation_m, 43.25);
    await call('cad_insert_terrain', { sourceId: source.id });
    await call('cad_save', { name: 'downloaded-terrain.dwg' });
    return { reply: '테스트용 지형을 저장했습니다.' };
  } };
  try {
    controller = await createDesktopController({ dataDir, agentUtilities, codexPath: '/app/codex', nodePath: '/app/node', secureStore: {},
      authFactory: async () => ({ status: () => ({ loggedIn: true }), getAccessToken: async () => 'test-token', close: async () => {} }),
      runtimeFactory: async () => runtime, bridgeTimeoutMs: 1000 });
    await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
    let finished = false;
    const turn = controller.chat({ message: '공개 지형 자료를 내려받아 도면에 넣고 저장해줘', context, history: [] });
    void turn.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      const job = await controller.pollCad({ waitMs: 10 });
      if (!job) continue;
      assert.equal(controller.claimCad(job.id).valid, true);
      if (job.method === 'context') controller.completeCad(job.id, context);
      else if (job.method === 'parcel_context') controller.completeCad(job.id, { context, georeference: null });
      else if (job.method === 'insert_terrain') {
        metadata = job.payload.plan.metadata;
        assert.equal(metadata.terrain.spotCount, 1); assert.equal(metadata.terrain.contourCount, 1);
        assert.equal(job.payload.plan.entities[0].elevationM, 42.5);
        context = { ...context, revision: 2 };
        controller.completeCad(job.id, { context, georeference: metadata });
      } else if (job.method === 'save') controller.completeCad(job.id, { context, georeferences: [metadata], dataBase64: Buffer.from('AC1032test-double').toString('base64'), version: 'AC1032', audit: { errors: 0, droppedOnSave: 0 } });
      else assert.fail(job.method);
    }
    const reply = await turn;
    assert.deepEqual(steps, ['cad_download', 'cad_terrain_register', 'cad_terrain_query', 'cad_insert_terrain', 'cad_save']);
    assert.deepEqual(visited, [url, finalUrl]);
    assert.equal(download.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(download.path), bytes);
    const saved = reply.details.find(item => item.tool === 'save');
    const sidecar = JSON.parse(await readFile(saved.metadataPath));
    assert.equal(sidecar.dwgSha256, saved.sha256);
    assert.equal(sidecar.georeferences[0].url, finalUrl);
    assert.equal(sidecar.georeferences[0].terrain.downloadedAt, download.retrievedAt);
    assert.equal(sidecar.georeferences[0].terrain.sourceSha256, download.sha256);
    assert.equal(reply.sources.find(item => item.kind === 'geodata').downloadedAt, download.retrievedAt);
    const reopened = await createTerrainData({ dataDir });
    assert.equal((await reopened.list())[0].id, dataset.id);
    assert.equal((await reopened.query({ datasetId: dataset.id, bbox })).features.length, 2);
  } finally { await controller?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
