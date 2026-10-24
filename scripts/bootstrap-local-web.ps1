$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$NodeVersion = '24.22.1'
$Runtime = Join-Path $Root '.runtime\local-web'
$SetupLock = $null
$Temporary = $null
$Result = 1
try {
    $Processor = $env:PROCESSOR_ARCHITEW6432
    if (-not $Processor) { $Processor = $env:PROCESSOR_ARCHITECTURE }
    switch ($Processor.ToUpperInvariant()) {
        'AMD64' { $Arch = 'x64'; $NodeSha = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5' }
        'ARM64' { $Arch = 'arm64'; $NodeSha = 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171' }
        default { throw 'Windows 10/11 64비트(x64 또는 ARM64)가 필요합니다.' }
    }
    [System.IO.Directory]::CreateDirectory($Runtime) > $null
    # The OS releases this exclusive handle after crashes; never delete another setup's lock.
    try { $SetupLock = [System.IO.File]::Open((Join-Path $Runtime 'setup.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
    catch { throw '다른 SiteCAD 설치가 진행 중이거나 설치 폴더에 접근할 수 없습니다. 완료 후 다시 실행해 주세요.' }
    $NodeRoot = Join-Path $Runtime "node-v$NodeVersion-win-$Arch"
    $Node = Join-Path $NodeRoot 'node.exe'
    $NodeReady = $false
    if (Test-Path -LiteralPath $Node -PathType Leaf) {
        $InstalledVersion = & $Node --version
        $VersionReady = $LASTEXITCODE -eq 0 -and $InstalledVersion -eq "v$NodeVersion"
        $InstalledArch = & $Node -p process.arch
        $NodeReady = $VersionReady -and $LASTEXITCODE -eq 0 -and $InstalledArch -eq $Arch
    }
    if (-not $NodeReady) {
        Write-Host 'SiteCAD 전용 실행 환경을 준비합니다...'
        $Temporary = Join-Path $Runtime ('download-' + [Guid]::NewGuid().ToString('N'))
        [System.IO.Directory]::CreateDirectory($Temporary) > $null
        $ArchiveName = "node-v$NodeVersion-win-$Arch.zip"
        $Archive = Join-Path $Temporary $ArchiveName
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Request = [Net.HttpWebRequest]::Create("https://nodejs.org/dist/v$NodeVersion/$ArchiveName")
        $Request.AllowAutoRedirect = $false
        $Request.Timeout = 30000
        $Request.ReadWriteTimeout = 30000
        $Response = $null; $InputStream = $null; $OutputStream = $null
        try {
            $Response = $Request.GetResponse()
            if ([int]$Response.StatusCode -ne 200 -or $Response.ContentLength -gt (96 * 1024 * 1024)) { throw '실행 환경 다운로드 응답이 올바르지 않습니다.' }
            $InputStream = $Response.GetResponseStream()
            $OutputStream = [IO.File]::Open($Archive, [IO.FileMode]::CreateNew)
            $Buffer = New-Object byte[] 65536
            $Bytes = 0; $Timer = [Diagnostics.Stopwatch]::StartNew()
            while (($Count = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                $Bytes += $Count
                if ($Bytes -gt (96 * 1024 * 1024) -or $Timer.Elapsed.TotalSeconds -gt 600) { throw '실행 환경 다운로드 크기 또는 시간 제한을 초과했습니다.' }
                $OutputStream.Write($Buffer, 0, $Count)
            }
        } finally {
            if ($OutputStream) { $OutputStream.Dispose() }
            if ($InputStream) { $InputStream.Dispose() }
            if ($Response) { $Response.Dispose() }
        }
        # Published in nodejs.org/dist/v24.22.1/SHASUMS256.txt.
        if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha) { throw '실행 환경 다운로드 무결성 검사에 실패했습니다. 다시 실행해 주세요.' }
        Expand-Archive -LiteralPath $Archive -DestinationPath $Temporary
        $Extracted = Join-Path $Temporary "node-v$NodeVersion-win-$Arch"
        $ExtractedNode = Join-Path $Extracted 'node.exe'
        if (-not (Test-Path -LiteralPath $ExtractedNode -PathType Leaf)) { throw '실행 환경 압축을 풀지 못했습니다.' }
        $ExtractedVersion = & $ExtractedNode --version
        if ($LASTEXITCODE -ne 0 -or $ExtractedVersion -ne "v$NodeVersion") { throw '실행 환경 버전이 올바르지 않습니다.' }
        if (Test-Path -LiteralPath $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
        Move-Item -LiteralPath $Extracted -Destination $NodeRoot
        Remove-Item -LiteralPath $Temporary -Recurse -Force
        $Temporary = $null
    }
    $env:PATH = "$NodeRoot;$env:PATH"
    $env:npm_config_cache = Join-Path $Runtime 'npm-cache'
    $env:npm_config_update_notifier = 'false'
    $PackageHash = (Get-FileHash -LiteralPath (Join-Path $Root 'package.json') -Algorithm SHA256).Hash
    $LockHash = (Get-FileHash -LiteralPath (Join-Path $Root 'package-lock.json') -Algorithm SHA256).Hash
    $Dependencies = "$PackageHash-$LockHash-$Arch-$NodeVersion-win32-node-only"
    $Ready = Join-Path $Runtime 'dependencies.ready'
    $Previous = if (Test-Path -LiteralPath $Ready -PathType Leaf) { [IO.File]::ReadAllText($Ready).Trim() } else { '' }
    if ($Previous -ne $Dependencies -or -not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\.package-lock.json') -PathType Leaf)) {
        Write-Host '도면·AI·MCP 의존성을 설치합니다. 처음에는 몇 분 걸릴 수 있습니다...'
        if (Test-Path -LiteralPath $Ready) { Remove-Item -LiteralPath $Ready -Force }
        & (Join-Path $NodeRoot 'npm.cmd') ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "의존성 설치에 실패했습니다(코드 $LASTEXITCODE). 네트워크를 확인한 뒤 다시 실행해 주세요." }
        if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\.package-lock.json') -PathType Leaf)) { throw '의존성 설치를 완료하지 못했습니다.' }
        [IO.File]::WriteAllText($Ready, $Dependencies)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'vendor\editor\manifest.local.json') -PathType Leaf)) {
        & (Join-Path $NodeRoot 'npm.cmd') run setup
        if ($LASTEXITCODE -ne 0) { throw 'OpenCADStudio 도면 편집기를 준비하지 못했습니다.' }
    }
    $EditorCheck = @'
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const root = resolve('vendor/editor');
const manifest = JSON.parse(await readFile(`${root}/manifest.local.json`, 'utf8'));
if (!Array.isArray(manifest.files) || !manifest.files.length) throw Error('도면 편집기 설치 정보가 없습니다.');
for (const file of manifest.files) {
  const target = resolve(root, file.path);
  if (!target.startsWith(`${root}${sep}`) || !(await stat(target)).size) throw Error('도면 편집기 파일이 손상되었습니다. 배포 ZIP을 다시 다운로드해 주세요.');
}
'@
    & $Node --input-type=module -e $EditorCheck
    if ($LASTEXITCODE -ne 0) { throw '도면 편집기 검증에 실패했습니다.' }
    $CodexCheck = @'
import { verifyCodexInstallation } from './scripts/install-codex.mjs';
try { await verifyCodexInstallation('runtime'); } catch { process.exit(1); }
'@
    & $Node --input-type=module -e $CodexCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'SiteCAD 전용 Codex 런타임을 준비합니다...'
        & $Node (Join-Path $Root 'scripts\install-codex.mjs') (Join-Path $Root 'runtime') $Arch
        if ($LASTEXITCODE -ne 0) { throw 'Codex 런타임 설치에 실패했습니다.' }
        & $Node --input-type=module -e $CodexCheck
        if ($LASTEXITCODE -ne 0) { throw 'Codex 런타임 검증에 실패했습니다.' }
    }
    $SetupLock.Dispose(); $SetupLock = $null
    Write-Host "`nSiteCAD를 브라우저에서 엽니다. 이 창을 닫거나 Ctrl+C를 누르면 서비스가 종료됩니다."
    & $Node (Join-Path $Root 'local-web.mjs')
    $Result = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("`nSiteCAD: " + $_.Exception.Message)
} finally {
    if ($Temporary -and (Test-Path -LiteralPath $Temporary)) { Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue }
    if ($SetupLock) { $SetupLock.Dispose() }
}
exit $Result
