import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installCodex, verifyCodexInstallation } from './install-codex.mjs';
import { copyTestDrawings } from './package-drawings.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);

export function windowsInstallerArguments({ appDirectory, output, version, script }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw Error('Invalid SiteCAD release version');
  if ([appDirectory, output, script].some(value => typeof value !== 'string' || !value || /["\x00-\x1f]/.test(value))) throw Error('Invalid installer path');
  return ['/Q', `/DAppVersion=${version}`, `/DAppDirectory=${appDirectory}`, `/DOutputDirectory=${output}`, script];
}

export function macSigningOptions({ release = false, env = process.env } = {}) {
  const identity = env.SITECAD_MAC_SIGN_IDENTITY;
  const keychainProfile = env.SITECAD_MAC_NOTARY_PROFILE;
  if (!release && !identity && !keychainProfile) return {};
  if (typeof identity !== 'string' || /[\x00-\x1f\x7f]/.test(identity) || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) throw Error('A Developer ID Application identity with its private key is required for a Mac release');
  if (typeof keychainProfile !== 'string' || /[\x00-\x1f\x7f]/.test(keychainProfile) || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(keychainProfile)) throw Error('A stored notary profile is required for a Mac release');
  return {
    osxSign: { identity, continueOnError: false, optionsForFile: () => ({ hardenedRuntime: true, entitlements: ['com.apple.security.cs.allow-jit'] }),
      // Preserve upstream's Developer ID signature and the runtime manifest's exact binary digest.
      ignore: file => file.endsWith('/Contents/Resources/app/runtime/codex'),
    },
    osxNotarize: { keychainProfile },
  };
}

export async function verifyBundledMacCodex(runtimeDirectory, { arch = process.arch, executeCommand = execute } = {}) {
  const binary = await verifyCodexInstallation(runtimeDirectory, { arch, platform: 'darwin' });
  await executeCommand('/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', binary], { timeout: 120000, maxBuffer: 16384 });
}

export async function verifyMacRelease({ appPath, dmgPath, signing, executeCommand = execute }) {
  const options = { timeout: 120000, maxBuffer: 32768 };
  await executeCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], options);
  await executeCommand('/usr/bin/xcrun', ['stapler', 'validate', appPath], options);
  await executeCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath], options);
  if (!dmgPath) return;
  await executeCommand('/usr/bin/codesign', ['--force', '--sign', signing.osxSign.identity, '--timestamp', dmgPath], options);
  const submission = await executeCommand('/usr/bin/xcrun', ['notarytool', 'submit', dmgPath, '--keychain-profile', signing.osxNotarize.keychainProfile, '--wait', '--output-format', 'json'], { timeout: 1200000, maxBuffer: 32768 });
  if (JSON.parse(submission.stdout).status !== 'Accepted') throw Error('Mac DMG notarization was not accepted');
  await executeCommand('/usr/bin/xcrun', ['stapler', 'staple', dmgPath], options);
  await executeCommand('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], options);
  await executeCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmgPath], options);
}

export async function buildDesktop({ arch = process.arch, archivePath, dmg = true, release = false } = {}) {
  const platform = process.platform;
  if (!['darwin', 'win32'].includes(platform)) throw Error('Build SiteCAD installers on macOS or Windows');
  if (!(platform === 'win32' ? ['x64'] : ['arm64']).includes(arch)) throw Error('Supported desktop targets: macOS arm64, Windows x64');
  const signing = platform === 'darwin' ? macSigningOptions({ release }) : {};
  const { packager } = await import('@electron/packager');
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageInfo.version)) throw Error('Invalid SiteCAD release version');
  const staging = await mkdtemp(join(tmpdir(), 'sitecad-package-'));
  const output = join(root, 'dist');
  try {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SOURCE_BUILD.md', 'server.mjs', 'lib', 'public', 'skills', 'vendor/editor', 'plan.schema.json', 'codex-models.json', 'desktop/main.mjs', 'desktop/runtime.mjs', 'desktop/licenses', 'desktop/sitecad.iss', 'scripts/install-codex.mjs', 'scripts/update-model-catalog.mjs', 'scripts/install-editor.mjs', 'scripts/build-desktop.mjs', 'scripts/package-drawings.mjs']) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await cp(join(root, name), join(staging, name), { recursive: true, dereference: false, errorOnExist: true,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) throw Error('Release source must not contain a symbolic link');
          const name = path.split(/[\\/]/).at(-1);
          return name !== '.env' && !name.startsWith('.env.') && name !== '.DS_Store' && !name.endsWith('.enc');
        },
      });
    }
    await copyTestDrawings(root, staging);
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
    if (signing.osxSign) await verifyBundledMacCodex(join(staging, 'runtime'), { arch });
    const apps = await packager({
      dir: staging, out: output, name: 'SiteCAD', executableName: 'SiteCAD', platform, arch,
      appBundleId: 'com.sitecad.desktop', appVersion: packageInfo.version, electronVersion: packageInfo.devDependencies.electron,
      asar: false, prune: false, overwrite: true, appCopyright: 'SiteCAD contributors', ...signing,
      ...(platform === 'win32' ? { win32metadata: { CompanyName: 'seominpapa' } } : {}),
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
      if (signing.osxSign) await verifyBundledMacCodex(join(appPath, 'Contents/Resources/app/runtime'), { arch });
      if (!signing.osxSign) {
        console.warn('Development Mac build: ad-hoc signature only; Gatekeeper approval is not established.');
        await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { timeout: 120000, maxBuffer: 16384 });
      }
      const dmgPath = dmg ? join(output, `SiteCAD-${packageInfo.version}-macOS-${arch}.dmg`) : undefined;
      if (dmg) {
        const imageRoot = await mkdtemp(join(tmpdir(), 'sitecad-dmg-'));
        try {
          await cp(appPath, join(imageRoot, 'SiteCAD.app'), { recursive: true, verbatimSymlinks: true });
          const { symlink } = await import('node:fs/promises');
          await symlink('/Applications', join(imageRoot, 'Applications'));
          await execute('/usr/bin/hdiutil', ['create', '-volname', 'SiteCAD', '-srcfolder', imageRoot, '-ov', '-format', 'UDZO', dmgPath], { timeout: 180000, maxBuffer: 16384 });
        } finally { await rm(imageRoot, { recursive: true, force: true }); }
      }
      if (signing.osxSign) await verifyMacRelease({ appPath, dmgPath, signing });
      console.log(`SiteCAD macOS ${arch}: ${appPath}`);
    }
    return apps;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const arch = process.argv.find(value => value.startsWith('--arch='))?.slice(7) || process.arch;
  const archivePath = process.argv.find(value => value.startsWith('--archive='))?.slice(10);
  await buildDesktop({ arch, archivePath, dmg: !process.argv.includes('--no-dmg'), release: process.argv.includes('--release') });
}
