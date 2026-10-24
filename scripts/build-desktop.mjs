import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installCodex } from './install-codex.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);

export async function buildDesktop({ arch = process.arch, archivePath, dmg = true } = {}) {
  if (process.platform !== 'darwin') throw Error('Build SiteCAD macOS installers on macOS');
  if (!['arm64', 'x64'].includes(arch)) throw Error('Only macOS arm64 and x64 are supported');
  const { packager } = await import('@electron/packager');
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const staging = await mkdtemp(join(tmpdir(), 'sitecad-package-'));
  const output = join(root, 'dist');
  try {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SOURCE_BUILD.md', 'server.mjs', 'lib', 'public', 'skills', 'vendor/editor', 'plan.schema.json', 'codex-models.json', 'desktop/main.mjs', 'desktop/runtime.mjs', 'desktop/licenses', 'scripts/install-codex.mjs', 'scripts/update-model-catalog.mjs', 'scripts/install-editor.mjs', 'scripts/build-desktop.mjs']) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await cp(join(root, name), join(staging, name), { recursive: true, dereference: false, errorOnExist: true });
    }
    await mkdir(join(staging, 'fixtures'));
    await cp(join(root, 'fixtures/retaining-wall.dwg'), join(staging, 'fixtures/retaining-wall.dwg'));
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...packageInfo, productName: 'SiteCAD', scripts: {}, main: 'desktop/main.mjs' }, null, 2)}\n`);
    await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'));
    await execute('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, timeout: 180000, maxBuffer: 16384 });
    await installCodex({ destination: join(staging, 'runtime'), arch, archivePath });
    const apps = await packager({
      dir: staging, out: output, name: 'SiteCAD', executableName: 'SiteCAD', platform: 'darwin', arch,
      appBundleId: 'com.sitecad.desktop', appVersion: packageInfo.version, electronVersion: packageInfo.devDependencies.electron,
      asar: false, prune: false, overwrite: true, appCopyright: 'SiteCAD contributors',
      extendInfo: { NSHumanReadableCopyright: 'SiteCAD. Includes OpenCADStudio (GPL-3.0) and Codex (Apache-2.0).', NSHighResolutionCapable: true },
    });
    for (const appDirectory of apps) {
      const appPath = join(appDirectory, 'SiteCAD.app');
      await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { timeout: 120000, maxBuffer: 16384 });
      if (dmg) {
        const dmgPath = join(output, `SiteCAD-${packageInfo.version}-macOS-${arch}.dmg`);
        const imageRoot = await mkdtemp(join(tmpdir(), 'sitecad-dmg-'));
        try {
          await cp(appPath, join(imageRoot, 'SiteCAD.app'), { recursive: true });
          const { symlink } = await import('node:fs/promises');
          await symlink('/Applications', join(imageRoot, 'Applications'));
          await execute('/usr/bin/hdiutil', ['create', '-volname', 'SiteCAD', '-srcfolder', imageRoot, '-ov', '-format', 'UDZO', dmgPath], { timeout: 180000, maxBuffer: 16384 });
        } finally { await rm(imageRoot, { recursive: true, force: true }); }
      }
      console.log(`SiteCAD macOS ${arch}: ${appPath}`);
    }
    return apps;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arch = process.argv.find(value => value.startsWith('--arch='))?.slice(7) || process.arch;
  const archivePath = process.argv.find(value => value.startsWith('--archive='))?.slice(10);
  await buildDesktop({ arch, archivePath, dmg: !process.argv.includes('--no-dmg') });
}
