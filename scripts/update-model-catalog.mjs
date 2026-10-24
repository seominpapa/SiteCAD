import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_VERSION } from './install-codex.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultBinary = join(root, 'runtime', ...(process.platform === 'win32' ? ['bin', 'codex.exe'] : ['codex']));
const executeFile = promisify(execFile);

export async function updateModelCatalog({ codexPath = defaultBinary, outputPath = join(root, 'codex-models.json'), execute = executeFile } = {}) {
  if (!isAbsolute(codexPath) || !isAbsolute(outputPath)) throw Error('Catalog input and output paths must be absolute.');
  const temporary = await mkdtemp(join(tmpdir(), 'sitecad-model-catalog-'));
  const pending = join(dirname(outputPath), `.sitecad-model-catalog-${process.pid}-${Date.now()}.tmp`);
  // --bundled is offline. Neither the ordinary Codex home nor credentials are inherited.
  const env = { CODEX_HOME: temporary, PATH: process.env.PATH || '', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const options = { cwd: temporary, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  try {
    const version = await execute(codexPath, ['--version'], options);
    if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw Error(`The model catalog requires pinned Codex ${CODEX_VERSION}.`);
    const bundled = await execute(codexPath, ['debug', 'models', '--bundled'], options);
    const source = JSON.parse(bundled.stdout);
    if (!Array.isArray(source.models) || !source.models.length || source.models.length > 1000) throw Error('The bundled model catalog is invalid.');
    const slugs = source.models.map(model => model?.slug);
    if (slugs.some(slug => typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)) || new Set(slugs).size !== slugs.length) throw Error('The bundled model identities are invalid.');
    // Keep every native field and hidden entry; only standard Responses is required for hosted search.
    const catalog = { ...source, models: source.models.map(model => ({ ...model, use_responses_lite: false })) };
    await writeFile(pending, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(pending, outputPath);
    return { version: CODEX_VERSION, models: catalog.models.length, outputPath };
  } finally { await rm(pending, { force: true }); await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4) throw Error('Usage: node scripts/update-model-catalog.mjs [codex-path] [output-path]');
    const result = await updateModelCatalog({ ...(process.argv[2] ? { codexPath: resolve(process.argv[2]) } : {}), ...(process.argv[3] ? { outputPath: resolve(process.argv[3]) } : {}) });
    console.log(`Updated ${result.models} models from Codex ${result.version}: ${result.outputPath}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
