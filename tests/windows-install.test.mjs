import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, copyFile, writeFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const scriptUrl = new URL('../scripts/bootstrap-local-web.ps1', import.meta.url);

test('Windows double-click entry invokes only process-scoped PowerShell and preserves failed exit', async () => {
  const bytes = await readFile(new URL('../Start SiteCAD.cmd', import.meta.url));
  const command = bytes.toString('utf8');
  assert.ok(bytes.includes(Buffer.from([13, 10])), 'CMD lines must use actual CRLF bytes');
  assert.doesNotMatch(command, /\\r\\n/);
  assert.doesNotMatch(command, /(?<!\r)\n/);
  assert.match(command, /-NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\bootstrap-local-web\.ps1"/);
  assert.match(command, /set "SITECAD_EXIT=%ERRORLEVEL%"/);
  assert.match(command, /pause/);
  assert.match(command, /exit \/b %SITECAD_EXIT%/);
  assert.doesNotMatch(command, /RunAs|Set-ExecutionPolicy|npm install -g/i);
});

test('Windows bootstrap pins official private Node ZIPs and bounds verified downloads', async () => {
  const bytes = await readFile(scriptUrl);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 requires UTF-8 BOM for Korean source');
  const script = bytes.toString('utf8');
  assert.match(script, /NodeVersion = '24\.22\.1'/);
  assert.match(script, /d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5/);
  assert.match(script, /a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171/);
  assert.match(script, /PROCESSOR_ARCHITEW6432/);
  assert.match(script, /FileShare\]::None/);
  assert.match(script, /FileMode\]::OpenOrCreate/);
  assert.match(script, /ReadWriteTimeout = 30000/);
  assert.match(script, /Elapsed\.TotalSeconds -gt 600/);
  assert.match(script, /96 \* 1024 \* 1024/);
  assert.match(script, /Get-FileHash -LiteralPath \$Archive -Algorithm SHA256/);
  assert.match(script, /ci --omit=dev --no-audit --no-fund/);
  assert.match(script, /package-lock\.json/);
  assert.match(script, /-win32-node-only/);
  assert.match(script, /verifyCodexInstallation\('runtime'\)/);
  assert.match(script, /& \$Node \(Join-Path \$Root 'local-web\.mjs'\)/);
  assert.doesNotMatch(script, /Set-ExecutionPolicy|RunAs|npm install -g|Remove-Item[^\r\n]*setup\.lock|electron/i);
});

const nativeWindows = process.platform === 'win32';
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const powershell = code => execute('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);

test('Windows PowerShell parses the complete UTF-8 bootstrap', { skip: !nativeWindows }, async () => {
  await powershell(`$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(fileURLToPath(scriptUrl))},[ref]$null,[ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`);
});

async function windowsFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'SiteCAD 한글 space '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, '.runtime/local-web');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  const script = join(root, 'scripts/bootstrap-local-web.ps1');
  await copyFile(scriptUrl, script);
  return { root, runtime, script };
}

test('another Windows installer cannot replace a held lock in a Korean path', { skip: !nativeWindows }, async t => {
  const { runtime, script } = await windowsFixture(t);
  const lock = join(runtime, 'setup.lock');
  await writeFile(lock, 'preserve owner');
  await assert.rejects(powershell(`$lock=[IO.File]::Open(${psLiteral(lock)},[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${psLiteral(script)}; $result=$LASTEXITCODE } finally { $lock.Dispose() }; exit $result`), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SiteCAD/);
    return true;
  });
  assert.equal(await readFile(lock, 'utf8'), 'preserve owner');
});

test('Windows stale lock is reusable and failed npm never leaves ready state', { skip: !nativeWindows || process.version !== 'v24.22.1' }, async t => {
  const { root, runtime, script } = await windowsFixture(t);
  const nodeRoot = join(runtime, `node-v24.22.1-win-${process.arch}`);
  await mkdir(nodeRoot);
  await copyFile(process.execPath, join(nodeRoot, 'node.exe'));
  await writeFile(join(nodeRoot, 'npm.cmd'), '@echo off\r\nexit /b 39\r\n');
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(runtime, 'setup.lock'), 'abandoned');
  await writeFile(join(runtime, 'dependencies.ready'), 'old');
  const invoke = () => execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  await assert.rejects(invoke(), error => error.code === 1 && /39/.test(error.stderr));
  await assert.rejects(stat(join(runtime, 'dependencies.ready')), { code: 'ENOENT' });
  await assert.rejects(invoke(), error => error.code === 1 && /39/.test(error.stderr));
  assert.equal(await readFile(join(runtime, 'setup.lock'), 'utf8'), 'abandoned');
});

test('actual CMD wrapper runs the quoted PowerShell file and preserves success and failure', { skip: !nativeWindows }, async t => {
  const { root, script } = await windowsFixture(t);
  const command = join(root, 'Start SiteCAD.cmd');
  await copyFile(new URL('../Start SiteCAD.cmd', import.meta.url), command);
  const invoke = () => new Promise((resolve, reject) => {
    const child = execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${command}""`], { windowsVerbatimArguments: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
    });
    child.stdin.end('\r\n');
  });
  await writeFile(script, 'exit 39\r\n');
  await assert.rejects(invoke(), error => error.code === 39 && /SiteCAD setup or startup failed/.test(error.stdout));
  await writeFile(script, 'exit 0\r\n');
  assert.doesNotMatch((await invoke()).stdout, /failed/);
});
