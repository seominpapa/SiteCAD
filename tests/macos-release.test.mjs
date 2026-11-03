import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, codexTarget, fileSha256 } from '../scripts/install-codex.mjs';
import { installBundledCodex } from '../desktop/runtime.mjs';
import { macSigningOptions, verifyBundledMacCodex, verifyMacRelease } from '../scripts/build-desktop.mjs';

const env = { SITECAD_MAC_SIGN_IDENTITY: 'Developer ID Application: Test Publisher (ABCDEFGHIJ)', SITECAD_MAC_NOTARY_PROFILE: 'SiteCAD' };

test('Mac release refuses missing or partial signing credentials instead of silently producing an unsigned release', () => {
  assert.deepEqual(macSigningOptions({env:{}}), {});
  for (const source of [{}, {SITECAD_MAC_SIGN_IDENTITY:env.SITECAD_MAC_SIGN_IDENTITY}, {SITECAD_MAC_NOTARY_PROFILE:'SiteCAD'}, {...env,SITECAD_MAC_SIGN_IDENTITY:'-'}, {...env,SITECAD_MAC_NOTARY_PROFILE:'bad\nprofile'}, {...env,SITECAD_MAC_NOTARY_PROFILE:'SiteCAD\n'}, {...env,SITECAD_MAC_SIGN_IDENTITY:env.SITECAD_MAC_SIGN_IDENTITY+'\n'}]) {
    assert.throws(() => macSigningOptions({release:true,env:source}), /Developer ID Application|notary profile/);
  }
  const options = macSigningOptions({release:true,env});
  assert.equal(options.osxSign.identity, env.SITECAD_MAC_SIGN_IDENTITY);
  assert.equal(options.osxSign.optionsForFile('/app/Contents/Resources/app/runtime/codex').hardenedRuntime, true);
  assert.deepEqual(options.osxNotarize, {keychainProfile:'SiteCAD'});
  assert.equal(options.osxSign.continueOnError, false);
  assert.equal(options.osxSign.ignore('/tmp/SiteCAD.app/Contents/Resources/app/runtime/codex'), true);
  assert.equal(options.osxSign.ignore('/tmp/SiteCAD.app/Contents/Resources/app/runtime/codex-other'), false);
  assert.equal(options.osxSign.ignore('/tmp/SiteCAD.app/Contents/Frameworks/helper'), false);
});

test('Mac distribution verifies app trust and requires accepted DMG notarization and stapled tickets', async () => {
  const calls = [];
  const executeCommand = async (command,args) => { calls.push([command,args]); return {stdout:JSON.stringify({status:'Accepted'})}; };
  await verifyMacRelease({appPath:'/tmp/SiteCAD.app',dmgPath:'/tmp/SiteCAD.dmg',signing:macSigningOptions({release:true,env}),executeCommand});
  assert.deepEqual(calls.map(([command,args]) => [command,...args.slice(0,2)]), [
    ['/usr/bin/codesign','--verify','--deep'], ['/usr/bin/xcrun','stapler','validate'], ['/usr/sbin/spctl','--assess','--type'],
    ['/usr/bin/codesign','--force','--sign'], ['/usr/bin/xcrun','notarytool','submit'], ['/usr/bin/xcrun','stapler','staple'],
    ['/usr/bin/xcrun','stapler','validate'], ['/usr/sbin/spctl','--assess','--type'],
  ]);
  assert.ok(calls[4][1].includes('--wait'));
  assert.deepEqual(calls[7][1], ['--assess','--type','open','--context','context:primary-signature','/tmp/SiteCAD.dmg']);
  let attempted = 0;
  await assert.rejects(verifyMacRelease({appPath:'/tmp/SiteCAD.app',dmgPath:'/tmp/SiteCAD.dmg',signing:macSigningOptions({release:true,env}),executeCommand:async () => { attempted++; throw Error('Gatekeeper rejected'); }}), /Gatekeeper rejected/);
  assert.equal(attempted, 1);
  await assert.rejects(verifyMacRelease({appPath:'/tmp/SiteCAD.app',dmgPath:'/tmp/SiteCAD.dmg',signing:macSigningOptions({release:true,env}),executeCommand:async () => ({stdout:'{"status":"Invalid"}'})}), /notarization was not accepted/);
});


test('Mac packaging preserves the signed official Codex bytes and its manifest so desktop runtime installation still verifies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sitecad-codex-signing-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const binary = join(directory,'codex');
  await writeFile(binary,'already Developer-ID-signed upstream fixture');
  const digest = await fileSha256(binary);
  const target = codexTarget('arm64','darwin');
  const manifest = {version:CODEX_VERSION,arch:'arm64',platform:'darwin',sha256:digest,files:{codex:digest},archiveSha256:target.sha256,source:target.url};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
  const calls = [];
  const executeCommand = async (command,args) => { calls.push([command,args]); };
  await verifyBundledMacCodex(directory,{arch:'arm64',executeCommand});
  assert.deepEqual(calls, [['/usr/bin/codesign',['--verify','--strict','-R','=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',binary]]]);
  const destination = join(directory,'installed/codex');
  await installBundledCodex({sourceDir:directory,destination,arch:'arm64',platform:'darwin'});
  assert.equal(await fileSha256(destination),digest);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),manifest);
  await writeFile(binary,'packager accidentally re-signed the binary');
  await assert.rejects(verifyBundledMacCodex(directory,{arch:'arm64',executeCommand}), /integrity check failed/);
  await assert.rejects(installBundledCodex({sourceDir:directory,destination,arch:'arm64',platform:'darwin'}), /integrity check failed/);
  assert.equal(await fileSha256(destination),digest);
});
