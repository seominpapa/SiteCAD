$ErrorActionPreference = 'Stop'
$parentId = [int]$env:SITECAD_UPDATE_PARENT
$installer = $env:SITECAD_UPDATE_INSTALLER
$destination = $env:SITECAD_UPDATE_DESTINATION
$result = $env:SITECAD_UPDATE_RESULT
$version = $env:SITECAD_UPDATE_VERSION
$ready = $env:SITECAD_UPDATE_READY
$download = $env:SITECAD_UPDATE_DOWNLOAD
$installerRunning = $false
function Remove-Download {
  if (!$download -or $installerRunning) { return }
  $directory = [System.IO.Path]::GetDirectoryName($download)
  if ([System.IO.Path]::GetDirectoryName($directory) -ne [System.IO.Path]::GetDirectoryName($result) -or [System.IO.Path]::GetFileName($directory) -notlike 'download-*' -or [System.IO.Path]::GetFileName($download) -ne "SiteCAD-$version-Windows-x64-Setup.exe") { return }
  try {
    Remove-Item -LiteralPath $download -Force -ErrorAction Stop
    if ([System.IO.Directory]::GetFileSystemEntries($directory).Count -eq 0) { [System.IO.Directory]::Delete($directory) }
  } catch { }
}
function Record-Result($status, $code, $launchedPid = $null) {
  @{ status = $status; code = $code; version = $version; launchedPid = $launchedPid } | ConvertTo-Json -Compress | Set-Content -LiteralPath "$result.tmp.$PID" -Encoding UTF8
  Move-Item -LiteralPath "$result.tmp.$PID" -Destination $result -Force
  Remove-Download
  if ($status -eq 'failed') {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show('SiteCAD 업데이트를 완료하지 못했습니다. 기존 앱을 다시 실행하거나 GitHub 릴리스의 설치 파일로 수동 업데이트해 주세요. 도면과 사용자 설정은 삭제하지 않았습니다.', 'SiteCAD 업데이트', 'OK', 'Warning') | Out-Null
    } catch { }
  }
}
try {
  if ($parentId -le 0 -or $version -notmatch '^\d+\.\d+\.\d+$' -or !$installer -or !$destination -or $destination.Contains('"')) { throw 'Invalid update parameters' }
  [System.IO.File]::WriteAllText($ready, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (Get-Process -Id $parentId -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -ge $deadline) { Record-Result 'failed' 'parent-running'; exit 1 }
    Start-Sleep -Milliseconds 200
  }
  $arguments = ConvertFrom-Json $env:SITECAD_UPDATE_ARGUMENTS
  $installerRunning = $true
  $install = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
  $installerRunning = $false
  if ($install.ExitCode -ne 0) { Record-Result 'failed' 'installer'; exit 1 }
  $launched = Start-Process -FilePath (Join-Path $destination 'SiteCAD.exe') -PassThru
  Record-Result 'installed' 'complete' $launched.Id
} catch {
  Record-Result 'failed' 'installer'
  exit 1
}
