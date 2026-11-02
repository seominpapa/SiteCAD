import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installCodex } from './install-codex.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);

export function windowsInstallerArguments({ appDirectory, output, version, script }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw Error('Invalid SiteCAD release version');
  if ([appDirectory, output, script].some(value => typeof value !== 'string' || !value || /["\x00-\x1f]/.test(value))) throw Error('Invalid installer path');
  return ['/Q', `/DAppVersion=${version}`, `/DAppDirectory=${appDirectory}`, `/DOutputDirectory=${output}`, script];
}

export async function buildDesktop({ arch = process.arch, archivePath, dmg = true } = {}) {
  const platform = process.platform;
  if (!['darwin', 'win32'].includes(platform)) throw Error('Build SiteCAD installers on macOS or Windows');
  if (!(platform === 'win32' ? ['x64'] : ['arm64', 'x64']).includes(arch)) throw Error('Supported desktop targets: macOS arm64/x64, Windows x64');
  const { packager } = await import('@electron/packager');
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageInfo.version)) throw Error('Invalid SiteCAD release version');
  const staging = await mkdtemp(join(tmpdir(), 'sitecad-package-'));
  const output = join(root, 'dist');
  try {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SOURCE_BUILD.md', 'server.mjs', 'lib', 'public', 'skills', 'vendor/editor', 'plan.schema.json', 'codex-models.json', 'desktop/main.mjs', 'desktop/runtime.mjs', 'desktop/licenses', 'desktop/sitecad.iss', 'scripts/install-codex.mjs', 'scripts/update-model-catalog.mjs', 'scripts/install-editor.mjs', 'scripts/build-desktop.mjs']) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await cp(join(root, name), join(staging, name), { recursive: true, dereference: false, errorOnExist: true,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) throw Error('Release source must not contain a symbolic link');
          const name = path.split(/[\\/]/).at(-1);
          return name !== '.env' && !name.startsWith('.env.') && name !== '.DS_Store' && !name.endsWith('.enc');
        },
      });
    }
    await mkdir(join(staging, 'fixtures'));
    if ((await lstat(join(root, 'fixtures/retaining-wall.dwg'))).isSymbolicLink()) throw Error('Drawing fixture must not be a symbolic link');
    await cp(join(root, 'fixtures/retaining-wall.dwg'), join(staging, 'fixtures/retaining-wall.dwg'));
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...packageInfo, productName: 'SiteCAD', scripts: {}, main: 'desktop/main.mjs' }, null, 2)}\n`);
    await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'));
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    const npmCli = process.env.npm_execpath || (platform === 'win32' ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined);
    await execute(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...npmArgs] : npmArgs, {
      cwd: staging, timeout: 180000, maxBuffer: 16384, windowsHide: true,
      env: { ...process.env, npm_config_cpu: arch, npm_config_os: platform },
    });
    await installCodex({ destination: join(staging, 'runtime'), arch, platform, archivePath });
    const apps = await packager({
      dir: staging, out: output, name: 'SiteCAD', executableName: 'SiteCAD', platform, arch,
      appBundleId: 'com.sitecad.desktop', appVersion: packageInfo.version, electronVersion: packageInfo.devDependencies.electron,
      asar: false, prune: false, overwrite: true, appCopyright: 'SiteCAD contributors',
      ...(platform === 'darwin' ? { extendInfo: { NSHumanReadableCopyright: 'SiteCAD. Includes OpenCADStudio (GPL-3.0) and Codex (Apache-2.0).', NSHighResolutionCapable: true } } : {}),
    });
    for (const appDirectory of apps) {
      if (platform === 'win32') {
        const compiler = process.env.INNO_SETUP_COMPILER || join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe');
        await execute(compiler, windowsInstallerArguments({ appDirectory, output, version: packageInfo.version, script: join(root, 'desktop/sitecad.iss') }), { timeout: 600000, maxBuffer: 32768, windowsHide: true });
        console.log(`SiteCAD Windows ${arch}: ${join(output, `SiteCAD-${packageInfo.version}-Windows-x64-Setup.exe`)}`);
        continue;
      }
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
