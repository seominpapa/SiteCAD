import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateModelCatalog } from '../scripts/update-model-catalog.mjs';
import { CODEX_VERSION } from '../scripts/install-codex.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = join(root, 'runtime', ...(process.platform === 'win32' ? ['bin', 'codex.exe'] : ['codex']));
const source = { metadata: { version: 'test' }, models: [{ slug: 'first', visibility: 'list', supported_in_api: true, supports_search_tool: true, use_responses_lite: true, nested: { preserve: ['all', 'metadata'] } }, { slug: 'hidden', visibility: 'hide', use_responses_lite: true }] };

test('offline catalog generation preserves all metadata, pins version and isolates Codex state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-catalog-test-')); const calls = [];
  const outputPath = join(directory, 'catalog.json');
  try {
    const original = JSON.stringify(source);
    const result = await updateModelCatalog({ codexPath: binary, outputPath, execute: async (...args) => { calls.push(args); return { stdout: args[1][0] === '--version' ? `codex-cli ${CODEX_VERSION}\n` : JSON.stringify(source) }; } });
    assert.deepEqual(result, { version: CODEX_VERSION, models: 2, outputPath });
    assert.equal(JSON.stringify(source), original);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { ...source, models: source.models.map(model => ({ ...model, use_responses_lite: false })) });
    assert.deepEqual(calls.map(call => call[1]), [['--version'], ['debug', 'models', '--bundled']]);
    assert.ok(isAbsolute(calls[0][2].env.CODEX_HOME));
    assert.equal(calls[0][2].cwd, calls[0][2].env.CODEX_HOME);
    assert.equal(calls[0][2].env.ACCESS_TOKEN, undefined);
    assert.equal(calls[0][2].env.OPENAI_API_KEY, undefined);
    await assert.rejects(access(calls[0][2].env.CODEX_HOME));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('wrong versions, malformed catalogs and failed commands never publish an output', async t => {
  for (const [name, response] of Object.entries({ version: 'codex-cli 0.1.0', malformed: '{invalid', missing: '{}', empty: '{"models":[]}', nullModel: '{"models":[null]}', duplicate: '{"models":[{"slug":"same"},{"slug":"same"}]}', unsafe: '{"models":[{"slug":"bad\\nname"}]}', failure: null })) {
    await t.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sitecad-catalog-invalid-')); let isolatedHome;
      try {
        const outputPath = join(directory, 'catalog.json');
        await assert.rejects(updateModelCatalog({ codexPath: binary, outputPath, execute: async (_binary, args, options) => { isolatedHome = options.env.CODEX_HOME; if (response === null) throw Error('command failed'); return { stdout: args[0] === '--version' ? name === 'version' ? response : `codex-cli ${CODEX_VERSION}` : response }; } }));
        await assert.rejects(access(outputPath)); await assert.rejects(access(isolatedHome));
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
  await assert.rejects(updateModelCatalog({ codexPath: 'relative', outputPath: '/tmp/out.json' }), /absolute/);
  await assert.rejects(updateModelCatalog({ codexPath: binary, outputPath: 'relative' }), /absolute/);
});

test('checked-in catalog exactly matches all pinned bundled metadata except Responses Lite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-catalog-bundled-'));
  try {
    const outputPath = join(directory, 'generated.json');
    const result = await updateModelCatalog({ outputPath });
    const generated = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(result.version, '0.163.0'); assert.equal(result.models, 11);
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(hash(JSON.parse(await readFile(join(root, 'codex-models.json'), 'utf8'))), hash(generated), 'Every bundled metadata field must match the generated catalog.');
    assert.deepEqual(generated.models.filter(model => model.visibility === 'list').map(model => model.slug), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
    assert.ok(generated.models.every(model => model.use_responses_lite === false && model.supports_search_tool === true && model.web_search_tool_type === 'text_and_image'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
