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
while ([DateTime]::UtcNow -lt $sitecadDeadline) {
  $sitecadDialogCondition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$SitecadProcessId),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'SiteCAD 종료'))
  $sitecadDialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $sitecadDialogCondition)
  if ($null -ne $sitecadDialog) {
    $sitecadButton = $sitecadDialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '종료'))
    if ($null -ne $sitecadButton) {
      $sitecadButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      $sitecadInvoked = $true
      break
    }
  }
  Start-Sleep -Milliseconds 200
}
if (!$sitecadInvoked) { throw 'SiteCAD close confirmation did not appear' }
if (!$sitecadProcess.WaitForExit(10000)) { throw 'SiteCAD did not exit after its close confirmation' }
if ($sitecadProcess.ExitCode -ne 0) { throw 'SiteCAD normal close returned an error' }
Write-Output 'SiteCAD close confirmation accepted; process exited normally'
