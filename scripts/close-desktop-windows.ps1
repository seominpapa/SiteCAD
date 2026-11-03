$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Normal-close verification requires a disposable CI desktop' }
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
  foreach ($sitecadWindow in $sitecadWindows) {
    try {
      $sitecadControls = $sitecadWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree, $sitecadProcessCondition)
      $sitecadObserved += @($sitecadControls)
      $sitecadWarnings = @($sitecadControls | Where-Object { $_.Current.Name.Contains('저장하지 않은 도면 변경은 사라집니다.') })
      if ($sitecadWarnings.Count -eq 0) { continue }
      $sitecadButtons = @($sitecadControls | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq '종료' -and $_.Current.IsEnabled
      })
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
      $sitecadName = $sitecadCurrent.Name.Replace("`r", ' ').Replace("`n", ' ')
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
