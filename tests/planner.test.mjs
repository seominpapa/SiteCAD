import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEnv, buildPrompt, parseCodexOutput, planWithCodex, oauthStatus } from '../lib/planner.mjs';

const input = { message: '6m 4m 사각형', context: { documentId: 2, revision: 0, units: 4, selection: [], entities: [] }, history: [] };
test('uses existing ChatGPT login without passing API key or alternate routing', () => {
  const env = cleanEnv({ PATH: '/bin', CODEX_HOME: '/tmp/auth', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'x', OPENAI_ORG_ID: 'x', AZURE_OPENAI_API_KEY: 'secret' });
  assert.deepEqual(env, { PATH: '/bin', CODEX_HOME: '/tmp/auth' });
});
test('prompt establishes only geometric plans, units and untrusted input', () => {
  const prompt = buildPrompt(input);
  assert.match(prompt, /millimetres/);
  assert.match(prompt, /untrusted/);
  assert.match(prompt, /도구/);
  assert.match(prompt, /6m 4m/);
});
test('parses final agent JSON and refuses absent, invalid or tool-based results', () => {
  const payload = { reply: '생성', operations: [{ type: 'rectangle', x_mm: 0, y_mm: 0, width_mm: 6000, height_mm: 4000 }] };
  assert.deepEqual(parseCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(payload) } })), payload);
  assert.throws(() => parseCodexOutput('not json'));
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"reply":"x","operations":[{"type":"exec"}]}' } })));
  assert.throws(() => parseCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })));
});
test('codex runner isolates cwd and uses OAuth-only official provider', async () => {
  let called;
  const run = async (args, options) => { called = { args, options }; return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"reply":"치수?","operations":[]}' } }); };
  assert.deepEqual(await planWithCodex(input, { run }), { reply: '치수?', operations: [] });
  assert.ok(called.args.includes('--ignore-user-config'));
  assert.ok(called.args.includes('--output-schema'));
  assert.ok(called.args.includes('model_provider="openai"'));
  assert.match(called.options.cwd, /sitecad-/);
  assert.equal(called.options.timeout, 120000);
});
test('oauth status requires ChatGPT login and fails closed', async () => {
  assert.equal((await oauthStatus({ run: async () => 'Logged in using ChatGPT' })).connected, true);
  assert.equal((await oauthStatus({ run: async () => 'Logged in using an API key' })).connected, false);
  assert.equal((await oauthStatus({ run: async () => { throw Error('private'); } })).connected, false);
});
