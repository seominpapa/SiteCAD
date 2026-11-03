$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Normal-close verification requires a disposable CI desktop' }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sitecadProcess = Get-Process -Id $SitecadProcessId
if ($sitecadProcess.ProcessName -ne 'SiteCAD' -or $sitecadProcess.MainWindowHandle -eq 0) { throw 'Expected the verified SiteCAD window' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SitecadClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam); }'
if (![SitecadClose]::PostMessage($sitecadProcess.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not request window close' }
$sitecadDeadline = [DateTime]::UtcNow.AddSeconds(20)
$sitecadInvoked = $false
$sitecadProcessCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$SitecadProcessId)
$sitecadObserved = @()
while ([DateTime]::UtcNow -lt $sitecadDeadline) {
  $sitecadObserved = @()
  # Native task-dialog titles vary; identify the owned warning and its exact exit button instead.
  $sitecadWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $sitecadProcessCondition)
  for ($sitecadWindowIndex = 0; $sitecadWindowIndex -lt $sitecadWindows.Count; $sitecadWindowIndex++) {
    $sitecadWindow = $sitecadWindows[$sitecadWindowIndex]
    try {
      $sitecadControls = $sitecadWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree, $sitecadProcessCondition)
      $sitecadHasWarning = $false
      $sitecadButtons = @()
      for ($sitecadControlIndex = 0; $sitecadControlIndex -lt $sitecadControls.Count; $sitecadControlIndex++) {
        $sitecadControl = $sitecadControls[$sitecadControlIndex]
        $sitecadCurrent = $sitecadControl.Current
        if ($sitecadCurrent.ProcessId -ne [int]$SitecadProcessId) { continue }
        $sitecadObserved += $sitecadControl
        $sitecadName = [string]$sitecadCurrent.Name
        if ($sitecadName.Contains('저장하지 않은 도면 변경은 사라집니다.')) { $sitecadHasWarning = $true }
        if ($sitecadCurrent.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $sitecadName -ceq '종료' -and $sitecadCurrent.IsEnabled) {
          $sitecadButtons += $sitecadControl
        }
      }
      if (!$sitecadHasWarning) { continue }
      if ($sitecadButtons.Count -eq 0) { continue }
      if ($sitecadButtons.Count -ne 1) { throw 'SiteCAD close confirmation had ambiguous exit buttons' }
      $sitecadButtons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      $sitecadInvoked = $true
      break
    } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
  }
  if ($sitecadInvoked) { break }
  Start-Sleep -Milliseconds 200
}
if (!$sitecadInvoked) {
  $sitecadDiagnostics = @()
  foreach ($sitecadControl in $sitecadObserved) {
    if ($sitecadDiagnostics.Count -ge 80) { break }
    try {
      $sitecadCurrent = $sitecadControl.Current
      if ($sitecadCurrent.ProcessId -ne [int]$SitecadProcessId) { continue }
      $sitecadName = ([string]$sitecadCurrent.Name).Replace("`r", ' ').Replace("`n", ' ')
      if ($sitecadName.Length -gt 120) { $sitecadName = $sitecadName.Substring(0, 120) }
      $sitecadDiagnostics += @{ name=$sitecadName; type=$sitecadCurrent.ControlType.ProgrammaticName }
    } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
  }
  Write-Output ('SiteCAD same-process controls: ' + (ConvertTo-Json -InputObject $sitecadDiagnostics -Compress))
  throw 'SiteCAD close confirmation did not appear'
}
if (!$sitecadProcess.WaitForExit(10000)) { throw 'SiteCAD did not exit after its close confirmation' }
if ($sitecadProcess.ExitCode -ne 0) { throw 'SiteCAD normal close returned an error' }
Write-Output 'SiteCAD close confirmation accepted; process exited normally'
