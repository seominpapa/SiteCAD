import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const base = { documentId: 2, revision: 3, units: 4, geometryRevision: 5, layout: 'Model', selection: [], entities: [], command: null };
const idle = { documentId: 2, units: 4, command: null, modal: null, textEditor: null, mtextEditor: null };
async function setup(t, action) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-command-controller-'));
  let controller;
  const runtime = { start: async () => {}, stop: async () => {}, status: () => ({}), chat: async () => action(controller) };
  controller = await createDesktopController({ dataDir, codexPath: '/app/codex', nodePath: '/app/node', secureStore: {}, bridgeTimeoutMs: 100,
    authFactory: async () => ({ getAccessToken: async () => 'test', close: async () => {} }), runtimeFactory: async () => runtime });
  await controller.start({ baseUrl: 'http://127.0.0.1:4317' });
  t.after(async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { controller, dataDir, turn: () => controller.chat({ message: '도면 작업', context: base, history: [] }) };
}
async function respond(controller, pending, result, error) {
  const job = await controller.pollCad();
  controller.completeCad(job.id, result, error);
  return pending;
}

test('MCP context preserves bounded native command metadata for continuation', async t => {
  const command = { name: 'DIMLINEAR', prompt: 'First point', accepts: ['point', 'token'], options: [{ keyword: 'HORIZONTAL', label: 'Horizontal', kind: 'keyword' }], input_example: { op: 'input', kind: 'point', point: [0, 0, 0] } };
  const env = await setup(t, async controller => {
    const context = await respond(controller, controller.callCad('context'), { ...base, command });
    assert.deepEqual(context.command, command);
    await assert.rejects(respond(controller, controller.callCad('context'), { ...base, command: { name: 'LINE', prompt: 'x'.repeat(20000) } }), /도면 상태/);
    return { reply: '상태 조회' };
  });
  await env.turn();
});

for (const mode of ['idle', 'command', 'modal', 'textEditor', 'mtextEditor', 'missing', 'failed control', 'failed control pending', 'changed document', 'read failure']) {
  test(`model completion checks the actual editor after control: ${mode}`, async t => {
    const env = await setup(t, async controller => {
      const pending = controller.callCad('control', { request: { op: 'start', cmd: 'LINE' }, expectedContext: base });
      const handled = mode.startsWith('failed control') ? assert.rejects(pending, /실패/) : pending;
      await handled;
      return { reply: '완료했습니다.' };
    });
    const turn = env.turn();
    const finished = mode === 'idle' || mode === 'failed control' ? turn : assert.rejects(turn, /완료|변경|확인/);
    const control = await env.controller.pollCad();
    assert.equal(control.method, 'control');
    env.controller.completeCad(control.id, { context: base, status: 'completed' }, mode.startsWith('failed control') ? '명령 실패' : undefined);
    const job = await env.controller.pollCad();
    assert.equal(job.method, 'completion_state');
    let state = { ...idle };
    if (['command', 'modal', 'textEditor', 'mtextEditor'].includes(mode)) state[mode] = { name: 'manual or owned' };
    if (mode === 'failed control pending') state.command = { name: 'LINE' };
    if (mode === 'missing') delete state.command;
    if (mode === 'changed document') state.documentId = 999;
    env.controller.completeCad(job.id, state, mode === 'read failure' ? '확인 실패' : undefined);
    await finished;
    assert.equal(await env.controller.pollCad({ waitMs: 0 }), null);
  });
}

for (const change of [{ documentId: 999 }, { units: 6 }, { geometryRevision: 6 }, { layout: 'Layout1' }, { selection: ['A'] }, { revision: 2 }, { geometryRevision: undefined }]) {
  test(`server rejects mismatched saved context before writing bytes: ${JSON.stringify(change)}`, async t => {
    const env = await setup(t, async controller => {
      const pending = controller.callCad('save', { name: 'mismatch.dwg', expectedContext: base });
      const failed = assert.rejects(pending, /저장.*변경|저장.*일치/);
      await respond(controller, failed, { context: { ...base, ...change }, version: 'AC1032', dataBase64: Buffer.from('AC1032test').toString('base64'), audit: { errors: 0, droppedOnSave: 0 } });
      assert.deepEqual(await readdir(join(env.dataDir, 'Drawings')), []);
      return { reply: '저장 거부' };
    });
    await env.turn();
  });
}

test('server accepts normal save revision advancement with unchanged geometry and units', async t => {
  const env = await setup(t, async controller => {
    const saved = await respond(controller, controller.callCad('save', { name: 'valid.dwg', expectedContext: base }), {
      context: { ...base, revision: 4 }, version: 'AC1032', dataBase64: Buffer.from('AC1032test').toString('base64'), audit: { errors: 0, droppedOnSave: 0 } });
    assert.equal(saved.context.revision, 4);
    return { reply: '저장 완료' };
  });
  await env.turn();
});
