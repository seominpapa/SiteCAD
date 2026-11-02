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
  await runPowerShell(`$p=${literal(path)};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $p;$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;$admin=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);if($owner -ne $id.Value -and -not($owner -eq 'S-1-5-32-544' -and $admin)){throw 'SiteCAD folder owner mismatch'};$a.SetOwner($id);$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};$r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a`);
}

export async function openLocal(value) {
  if (process.platform === 'win32') await runPowerShell(`Start-Process -FilePath (${literal(value)})`);
  else await execute('/usr/bin/open', [value], { timeout: 15000, maxBuffer: 4096 });
}

export async function selectLocalFolder({ defaultPath, signal, platform = process.platform, executeImpl = execute }) {
  const options = { timeout: 300000, maxBuffer: 16384, signal, windowsHide: true };
  try {
    let result;
    if (platform === 'darwin') {
      const initial = await lstat(defaultPath).then(info => info.isDirectory()).catch(() => false) ? defaultPath : homedir();
      const script = `on run argv
try
set selectedFolder to choose folder with prompt "SiteCAD 도면 저장 폴더 선택" default location (POSIX file (item 1 of argv))
return POSIX path of selectedFolder
on error number -128
return ""
end try
end run`;
      result = await executeImpl('/usr/bin/osascript', ['-e', script, initial], options);
    } else if (platform === 'win32') {
      const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='SiteCAD 도면 저장 폴더 선택';$dialog.SelectedPath=${literal(defaultPath)};$dialog.ShowNewFolderButton=$true;try{if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.SelectedPath)}}finally{$dialog.Dispose()}`;
      result = await executeImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
    } else throw Error('현재 운영체제에서는 폴더 선택을 지원하지 않습니다.');
    if (typeof result.stdout !== 'string' || result.stdout.length > 8192) throw Error();
    return result.stdout.trim() || null;
  } catch {
    if (!['darwin', 'win32'].includes(platform)) throw Error('현재 운영체제에서는 폴더 선택을 지원하지 않습니다.');
    throw Error(signal?.aborted ? '폴더 선택을 취소했습니다.' : '폴더 선택 창을 열지 못했습니다. 운영체제 권한과 선택한 폴더를 확인해 주세요.');
  }
}
