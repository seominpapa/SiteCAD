import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../lib/desktop-controller.mjs';

const TEST_ANTHROPIC_KEY = 'test-key-not-a-real-key';
const TEST_OPENAI_KEY = 'test-api-key-not-real';

const context = { documentId: 2, revision: 1, units: 4, selection: [], entities: [] };
async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-llm-controller-'));
  let saved, options, stopped = 0, oauthStarts = 0;
  const runtime = { start: async () => {}, listModels: async () => [{ id: 'test-model', isDefault: true }],
    chat: async () => ({ reply: 'API 도구 응답', details: [] }), status: () => ({ connected: true }),
    stop: async () => { stopped++; }, cancel: async () => {}, getMcpStatus: async () => [],
    testExternal: async name => ({ name, status: 'connected', tools: ['inspect'], tested: true }) };
  const controller = await createDesktopController({ dataDir, codexPath: '/fixture/codex', nodePath: process.execPath,
    secureStore: {}, llmSecretStore: { read: async () => saved ?? null, write: async value => { saved = structuredClone(value); } },
    authFactory: async () => ({ status: async () => ({ loggedIn: false }), getAccessToken: async () => { throw Error('OAuth must not be used'); }, close: async () => {}, cancel: async () => {}, logout: async () => {} }),
    runtimeFactory: async () => { oauthStarts++; throw Error('OAuth must not start'); },
    apiRuntimeFactory: value => { options = value; return runtime; }, bridgeTimeoutMs: 100, ...overrides });
  await controller.start({ baseUrl: 'http://127.0.0.1:4318' });
  t.after(async () => { await controller.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { controller, runtime, options: () => options, stopped: () => stopped, oauthStarts: () => oauthStarts };
}

test('API credentials select a real alternative runtime without requiring ChatGPT login', async t => {
  const value = await setup(t), secret = TEST_ANTHROPIC_KEY;
  await value.controller.llmSave({ id: 'anthropic-api', apiKey: secret });
  await value.controller.llmSelect({ id: 'anthropic-api' });
  const state = await value.controller.status();
  assert.equal(state.llm.active, 'anthropic-api');
  assert.equal(state.oauth.connected, true);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal((await value.controller.modelsList()).defaultModel, 'test-model');
  assert.equal(value.options().provider, 'anthropic');
  assert.equal((await value.options().getCredentials()).apiKey, secret);
  assert.equal((await value.controller.chat({ message: '도면을 확인해줘', context, history: [] })).reply, 'API 도구 응답');
  assert.equal(value.oauthStarts(), 0);
  await value.controller.llmRemove({ id: 'anthropic-api' });
  assert.ok(value.stopped() > 0);
  assert.equal((await value.controller.status()).oauth.connected, false);
});

test('Claude OAuth uses the official CLI runtime and never the API token path', async t => {
  let cliOptions, started = 0, apiStarts = 0;
  const value = await setup(t, {
    claudeCodeAuth: {
      status: async () => ({ loggedIn: true, available: true, pending: false }),
      runtimeOptions: async () => ({ claudePath: '/fixture/claude', claudeConfigDir: '/fixture/claude-profile' }),
      cancel: async () => {},
    },
    apiRuntimeFactory: () => { apiStarts++; throw Error('Subscription must not use the API'); },
    claudeCodeRuntimeFactory: options => {
      cliOptions = options;
      return { start: async () => { started++; }, status: () => ({ connected: true }),
        listModels: async () => [{ id: 'claude-test', isDefault: true }],
        chat: async () => ({ reply: '공식 CLI 응답', details: [] }),
        stop: async () => {}, cancel: async () => {} };
    },
  });
  await value.controller.llmSelect({ id: 'anthropic-oauth' });
  assert.equal((await value.controller.modelsList()).defaultModel, 'claude-test');
  assert.equal(started, 1);
  assert.equal(apiStarts, 0);
  assert.equal(cliOptions.getCredentials, undefined);
  assert.deepEqual(await cliOptions.getClaudeCodeConfig(), { claudePath: '/fixture/claude', claudeConfigDir: '/fixture/claude-profile' });
  assert.equal((await value.controller.status()).oauth.method, 'claude-code');
  assert.equal((await value.controller.chat({ message: '도면을 확인해줘', model: 'opus[1m]', context, history: [] })).reply, '공식 CLI 응답');
});

test('provider/key changes are rejected during a drawing turn and preserve the active connection', async t => {
  const value = await setup(t);
  await value.controller.llmSave({ id: 'openai-api', apiKey: TEST_OPENAI_KEY });
  await value.controller.llmSelect({ id: 'openai-api' });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  value.runtime.chat = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { reply: '완료' }; };
  const turn = value.controller.chat({ message: '도면 확인', context, history: [] });
  await started;
  try {
    await assert.rejects(value.controller.llmSelect({ id: 'anthropic-api' }), /작업/);
    await assert.rejects(value.controller.llmRemove({ id: 'openai-api' }), /작업/);
    assert.equal((await value.controller.status()).llm.active, 'openai-api');
  } finally { release(); await turn; }
});

test('settings exposes the complete pinned plugin review and requires explicit install and removal consent', async t => {
  const body = '# Reviewed instructions\n' + 'Instructions retained for user review.\n'.repeat(80);
  const plan = { planId: 'reviewed-plan', skills: [{ name: 'reviewed-skill', body }], warning: '검토 후 승인' };
  const calls = [];
  const value = await setup(t, { pluginFactory: () => ({
    inspect: async (url, { signal }) => {
      calls.push(['inspect', url]); assert.equal(signal.aborted, false);
      return { planId: plan.planId, skills: [{ name: 'reviewed-skill' }] };
    },
    review: planId => { calls.push(['review', planId]); return structuredClone(plan); },
    install: async (input, { signal, approve }) => {
      calls.push(['install', input]); assert.equal(signal.aborted, false);
      assert.equal(await approve(plan), true); return { installed: true };
    },
    remove: async (name, { approve }) => {
      calls.push(['remove', name]); assert.equal(await approve(plan), true); return { removed: true };
    },
  }) });
  const reviewed = await value.controller.pluginsInspect({ url: 'https://github.com/example/plugin' });
  assert.deepEqual(reviewed, plan);
  assert.equal(reviewed.skills[0].body, body);
  assert.deepEqual(calls, [['inspect', 'https://github.com/example/plugin'], ['review', plan.planId]]);
  for (const approved of [undefined, false, 'true']) {
    await assert.rejects(value.controller.pluginsInstall({ planId: plan.planId, ...(approved === undefined ? {} : { approved }) }), /승인/);
    await assert.rejects(value.controller.pluginsRemove({ name: 'reviewed-plugin', ...(approved === undefined ? {} : { approved }) }), /승인/);
  }
  await assert.rejects(value.controller.pluginsInstall({ planId: plan.planId, approved: true, body: 'changed after review' }), /승인/);
  assert.equal(calls.length, 2);
  assert.deepEqual(await value.controller.pluginsInstall({ planId: plan.planId, approved: true }), { installed: true });
  assert.deepEqual(await value.controller.pluginsRemove({ name: 'reviewed-plugin', approved: true }), { removed: true });
  assert.deepEqual(calls.slice(2), [['install', { planId: plan.planId }], ['remove', 'reviewed-plugin']]);
});

test('cancel and close abort slow settings inspections and reject their late successful results', async t => {
  for (const method of ['pluginsInspect', 'mcpInspect']) for (const action of ['cancel', 'close']) {
    await t.test(`${method} during ${action}`, async subtest => {
      let signal, release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      const inspect = (_url, options) => {
        signal = options.signal; entered();
        return new Promise(resolve => { release = () => resolve({ planId: 'late-plan' }); });
      };
      const value = await setup(subtest, { pluginFactory: () => ({ inspect, review: planId => ({ planId }) }),
        mcpInstaller: { inspect } });
      const pending = value.controller[method]({ url: 'https://github.com/example/plugin' });
      const rejected = assert.rejects(pending, /취소/);
      await started;
      await assert.rejects(value.controller.llmSave({ id: 'openai-api', apiKey: TEST_OPENAI_KEY }), /작업/);
      await value.controller[action]();
      const aborted = signal.aborted;
      release(); await rejected;
      assert.equal(aborted, true);
      const save = value.controller.llmSave({ id: 'openai-api', apiKey: TEST_OPENAI_KEY });
      if (action === 'cancel') await save;
      else await assert.rejects(save, /작업/);
    });
  }
});

test('settings MCP install rolls back only the new server and package when its real connection check fails', async t => {
  const installs = [], removed = [];
  const value = await setup(t, { mcpInstaller: {
    install: async (input, { signal, approve }) => {
      installs.push(input); assert.equal(signal.aborted, false); assert.equal(await approve({ planId: input.planId }), true);
      return { config: { name: input.name, transport: 'http', url: 'https://example.org/new-mcp' }, installation: { id: 'new-package-id' } };
    },
    remove: async id => { removed.push(id); },
  } });
  await value.controller.llmSave({ id: 'openai-api', apiKey: TEST_OPENAI_KEY });
  await value.controller.llmSelect({ id: 'openai-api' });
  await value.controller.mcpSave({ trusted: true, config: { name: 'existing', transport: 'http', url: 'https://example.org/existing' } });
  const request = { planId: 'reviewed-mcp-plan', name: 'new-server', args: ['--read-only'] };
  await assert.rejects(value.controller.mcpInstall(request), /승인/);
  await assert.rejects(value.controller.mcpInstall({ ...request, approved: false }), /승인/);
  await assert.rejects(value.controller.mcpInstall({ ...request, name: 'existing', approved: true }), /이미 등록/);
  assert.deepEqual(installs, []);
  value.runtime.testExternal = async (name, { signal }) => {
    assert.equal(name, 'new-server'); assert.equal(signal.aborted, false);
    assert.deepEqual(value.options().externalServers.map(server => server.name), ['existing', 'new-server']);
    return { name, tested: true, status: 'failed', tools: [] };
  };
  await assert.rejects(value.controller.mcpInstall({ ...request, approved: true }), /되돌렸/);
  assert.deepEqual(installs, [request]);
  assert.deepEqual(removed, ['new-package-id']);
  assert.deepEqual((await value.controller.mcpList()).servers.map(server => server.name), ['existing']);
  assert.equal(value.stopped(), 1);
});
