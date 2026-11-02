import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsInstallerArguments } from '../scripts/build-desktop.mjs';

test('Windows installer compiler receives separate arguments, preserving spaces and Korean paths', () => {
  const args = windowsInstallerArguments({ appDirectory: 'C:\\한글 폴더\\SiteCAD-win32-x64', output: 'C:\\릴리스 파일', version: '0.16.0', script: 'C:\\소스 폴더\\sitecad.iss' });
  assert.deepEqual(args, ['/Q', '/DAppVersion=0.16.0', '/DAppDirectory=C:\\한글 폴더\\SiteCAD-win32-x64', '/DOutputDirectory=C:\\릴리스 파일', 'C:\\소스 폴더\\sitecad.iss']);
  assert.throws(() => windowsInstallerArguments({ appDirectory: 'app', output: 'out', version: '0.16.0"\nAppName=Other', script: 'script' }), /version/);
  for (const path of ['', 'path"injection', 'path\nother', undefined]) assert.throws(() => windowsInstallerArguments({ appDirectory: path, output: 'out', version: '0.16.0', script: 'script' }), /path/);
});

test('Windows setup installs per user, creates shortcuts and preserves user drawings and settings on uninstall', async () => {
  const source = await readFile(new URL('../desktop/sitecad.iss', import.meta.url), 'utf8');
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\SiteCAD/);
  assert.match(source, /ArchitecturesAllowed=x64compatible/);
  assert.match(source, /OutputBaseFilename=SiteCAD-\{#AppVersion\}-Windows-x64-Setup/);
  assert.match(source, /Name: "\{autoprograms\}\\SiteCAD"; Filename: "\{app\}\\SiteCAD\.exe"/);
  assert.match(source, /Name: "\{autodesktop\}\\SiteCAD"; Filename: "\{app\}\\SiteCAD\.exe"/);
  assert.doesNotMatch(source, /\[UninstallDelete\]|\[Run\]|delappdata|deleteafterinstall/);
});

test('desktop packaging retains production native optional dependencies and makes native platform artifacts', async () => {
  const source = await readFile(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /--omit=optional/);
  assert.match(source, /INNO_SETUP_COMPILER/);
  assert.match(source, /npm_execpath/);
  assert.match(source, /installCodex\(\{[^}]*platform/);
  assert.match(source, /'desktop\/sitecad\.iss'/);
});

test('Windows packaging provides explicit publisher metadata without requiring an author in the source manifest', async () => {
  const source = await readFile(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8');
  const company = source.match(/win32metadata:\s*\{\s*CompanyName:\s*'([^']+)'/);
  assert.ok(company, 'Windows package needs an explicit CompanyName');
  assert.equal(company[1], 'seominpapa');
  const { getMetadataFromPackageJSON } = await import('../node_modules/@electron/packager/dist/infer.js');
  assert.deepEqual(await getMetadataFromPackageJSON(['win32'], {
    name: 'SiteCAD', appVersion: '0.16.0', electronVersion: '45.0.0', win32metadata: { CompanyName: company[1] },
  }, '/package-metadata-not-needed'), {});
});

test('macOS DMG staging keeps framework links relative and works after the build directory is moved', {skip: process.platform === 'win32'}, async t => {
  const source = await readFile(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8');
  const optionsText = source.match(/await cp\(appPath, join\(imageRoot, 'SiteCAD\.app'\), (\{[^}]+\})\)/)?.[1];
  assert.ok(optionsText, 'Use the actual DMG staging copy options');
  const options = Object.fromEntries([...optionsText.matchAll(/(\w+):\s*(true|false)/g)].map(([,key,value]) => [key,value === 'true']));
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-framework-copy-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const appPath = join(directory,'built.app'), imagePath = join(directory,'image/SiteCAD.app');
  const framework = 'Contents/Frameworks/Electron Framework.framework';
  await mkdir(join(appPath,framework,'Versions/A/Resources'), {recursive:true});
  await writeFile(join(appPath,framework,'Versions/A/Resources/icudtl.dat'), 'ICU fixture');
  await symlink('A',join(appPath,framework,'Versions/Current'));
  await symlink('Versions/Current/Resources',join(appPath,framework,'Resources'));
  await cp(appPath,imagePath,options);
  await rename(appPath,join(directory,'build-is-no-longer-here.app'));
  assert.equal(await readlink(join(imagePath,framework,'Resources')), 'Versions/Current/Resources');
  assert.equal(await readlink(join(imagePath,framework,'Versions/Current')), 'A');
  assert.equal(await readFile(join(imagePath,framework,'Resources/icudtl.dat'),'utf8'), 'ICU fixture');
});
