import { cp, chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
// Explicit files prevent credentials, local MCP config, downloaded executables and project drawings entering releases.
export const sourceEntries = Object.freeze([
  'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Start SiteCAD.command', 'Start SiteCAD.cmd',
  'server.mjs', 'local-web.mjs', 'lib', 'public', 'plan.schema.json', 'codex-models.json',
  'desktop/runtime.mjs', 'desktop/licenses', 'vendor/editor',
  'scripts/bootstrap-local-web.sh', 'scripts/bootstrap-local-web.ps1', 'scripts/install-codex.mjs', 'scripts/install-editor.mjs', 'scripts/build-local-web.mjs',
]);

export async function buildLocalWeb({ sourceRoot = root, platform = 'darwin', outputDirectory = join(sourceRoot, 'dist'),
  fixturePath = existsSync(join(sourceRoot, 'fixtures/retaining-wall.dwg')) ? join(sourceRoot, 'fixtures/retaining-wall.dwg')
    : join(sourceRoot, '../rhino-experiments/retaining-wall-20261020/retaining-wall-drawing-2d.dwg'),
} = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw Error('Unsupported SiteCAD release platform');
  const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageInfo.version)) throw Error('Invalid SiteCAD release version');
  await readFile(join(sourceRoot, 'vendor/editor/manifest.local.json'));
  const temporary = await mkdtemp(join(tmpdir(), 'sitecad-local-web-'));
  const staging = join(temporary, 'SiteCAD');
  try {
    for (const name of sourceEntries) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await cp(join(sourceRoot, name), join(staging, name), {
        recursive: true, dereference: false, errorOnExist: true,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) throw Error('Release source must not contain a symbolic link');
          const name = basename(path);
          return name !== '.env' && !name.startsWith('.env.') && name !== '.DS_Store' && !name.endsWith('.enc');
        },
      });
    }
    await mkdir(join(staging, 'fixtures'));
    if ((await lstat(fixturePath)).isSymbolicLink()) throw Error('Drawing fixture must not be a symbolic link');
    await cp(fixturePath, join(staging, 'fixtures/retaining-wall.dwg'));
    for (const name of ['Start SiteCAD.command', 'scripts/bootstrap-local-web.sh']) await chmod(join(staging, name), 0o755);
    await mkdir(outputDirectory, { recursive: true });
    const archive = resolve(outputDirectory, `SiteCAD-${packageInfo.version}-local-web-${platform === 'win32' ? 'Windows' : 'macOS'}.zip`);
    const pending = join(temporary, 'release.zip');
    if (process.platform === 'win32') {
      const command = '$ErrorActionPreference = \'Stop\'; Compress-Archive -LiteralPath SiteCAD -DestinationPath release.zip -CompressionLevel Optimal';
      await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { cwd: temporary, timeout: 180000, maxBuffer: 16384 });
    } else await execute('/usr/bin/zip', ['-q', '-r', pending, 'SiteCAD'], { cwd: temporary, timeout: 180000, maxBuffer: 16384 });
    await cp(pending, archive);
    return archive;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildLocalWeb({ platform: process.argv.includes('--windows') ? 'win32' : 'darwin' }));
