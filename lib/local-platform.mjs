import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const literal = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
const runPowerShell = script => execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop';${script}`, 'utf16le').toString('base64')], { timeout: 15000, maxBuffer: 4096, windowsHide: true });

export function defaultDataDir(platform = process.platform) {
  return platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SiteCAD Web')
    : join(homedir(), 'Library', 'Application Support', 'SiteCAD Web');
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && info.uid !== process.getuid())) throw Error('SiteCAD 개인 폴더 권한을 확인해 주세요.');
  if (process.platform !== 'win32') return chmod(path, 0o700);
  // Windows modes do not protect files; retain only this owner's access in the NTFS ACL.
  await runPowerShell(`$p=${literal(path)};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $p;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $id.Value){throw 'SiteCAD folder owner mismatch'};$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};$r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a`);
}

export async function openLocal(value) {
  if (process.platform === 'win32') await runPowerShell(`Start-Process -FilePath (${literal(value)})`);
  else await execute('/usr/bin/open', [value], { timeout: 15000, maxBuffer: 4096 });
}
