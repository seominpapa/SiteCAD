$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Normal-close verification requires a disposable CI desktop' }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sitecadProcess = Get-Process -Id $SitecadProcessId
if ($sitecadProcess.ProcessName -ne 'SiteCAD' -or $sitecadProcess.MainWindowHandle -eq 0) { throw 'Expected the verified SiteCAD window' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SitecadClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
}
'@
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
        if ($sitecadName -ceq '종료' -and $sitecadCurrent.IsEnabled) {
          $sitecadButtons += $sitecadControl
        }
      }
      if (!$sitecadHasWarning) { continue }
      if ($sitecadButtons.Count -eq 0) { continue }
      if ($sitecadButtons.Count -ne 1) { throw 'SiteCAD close confirmation had ambiguous exit buttons' }
      $sitecadInvoke = $null
      if ($sitecadButtons[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$sitecadInvoke)) {
        $sitecadInvoke.Invoke()
      } else {
        # Electron's TaskDialog uses custom button IDs 100 + index; '종료' is index 1.
        # TDM_CLICK_BUTTON selects that real button through the normal task-dialog callback.
        $sitecadExitCurrent = $sitecadButtons[0].Current
        if ([string]$sitecadExitCurrent.AutomationId -cne 'CommandLink_101') { continue }
        $sitecadExitHandle = [IntPtr]$sitecadExitCurrent.NativeWindowHandle
        if ($sitecadExitHandle -eq [IntPtr]::Zero) { continue }
        $sitecadDialogHandle = [SitecadClose]::GetAncestor($sitecadExitHandle, 2)
        if ($sitecadDialogHandle -eq [IntPtr]::Zero -or [SitecadClose]::GetWindow($sitecadDialogHandle, 4) -ne $sitecadProcess.MainWindowHandle) { continue }
        $sitecadExitClass = [System.Text.StringBuilder]::new(256)
        $sitecadDialogClass = [System.Text.StringBuilder]::new(256)
        [void][SitecadClose]::GetClassName($sitecadExitHandle, $sitecadExitClass, $sitecadExitClass.Capacity)
        [void][SitecadClose]::GetClassName($sitecadDialogHandle, $sitecadDialogClass, $sitecadDialogClass.Capacity)
        [uint32]$sitecadExitProcessId = 0
        [uint32]$sitecadDialogProcessId = 0
        [void][SitecadClose]::GetWindowThreadProcessId($sitecadExitHandle, [ref]$sitecadExitProcessId)
        [void][SitecadClose]::GetWindowThreadProcessId($sitecadDialogHandle, [ref]$sitecadDialogProcessId)
        if ($sitecadExitProcessId -ne [uint32]$SitecadProcessId -or $sitecadDialogProcessId -ne [uint32]$SitecadProcessId) { continue }
        if ($sitecadExitClass.ToString() -cne 'CCCommandLink' -or $sitecadDialogClass.ToString() -cne '#32770') { continue }
        $sitecadDialogControls = [System.Windows.Automation.AutomationElement]::FromHandle($sitecadDialogHandle).FindAll([System.Windows.Automation.TreeScope]::Subtree, $sitecadProcessCondition)
        $sitecadDialogHasWarning = $false
        for ($sitecadDialogIndex = 0; $sitecadDialogIndex -lt $sitecadDialogControls.Count; $sitecadDialogIndex++) {
          $sitecadDialogCurrent = $sitecadDialogControls[$sitecadDialogIndex].Current
          if ($sitecadDialogCurrent.ProcessId -eq [int]$SitecadProcessId -and [string]$sitecadDialogCurrent.Name -ceq '저장하지 않은 도면 변경은 사라집니다.') { $sitecadDialogHasWarning = $true }
        }
        if (!$sitecadDialogHasWarning) { continue }
        if (![SitecadClose]::PostMessage($sitecadDialogHandle, 0x0466, [IntPtr]101, [IntPtr]::Zero)) { throw 'Could not select the verified SiteCAD task-dialog exit button' }
      }
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
      $sitecadDiagnostic = @{ name=$sitecadName; type=$sitecadCurrent.ControlType.ProgrammaticName }
      if ($sitecadName -ceq '종료') {
        $sitecadPatterns = @()
        foreach ($sitecadPattern in $sitecadControl.GetSupportedPatterns()) {
          $sitecadPatterns += @{ id=$sitecadPattern.Id; name=$sitecadPattern.ProgrammaticName }
        }
        $sitecadLegacyRole = $null
        $sitecadLegacyRoleProperty = [System.Windows.Automation.AutomationProperty]::LookupById(30095)
        if ($null -ne $sitecadLegacyRoleProperty) {
          $sitecadLegacyRole = $sitecadControl.GetCurrentPropertyValue($sitecadLegacyRoleProperty, $true)
          if ($sitecadLegacyRole -eq [System.Windows.Automation.AutomationElement]::NotSupported) { $sitecadLegacyRole = $null }
        }
        $sitecadNativeParent = [SitecadClose]::GetParent([IntPtr]$sitecadCurrent.NativeWindowHandle)
        $sitecadNativeParentClass = [System.Text.StringBuilder]::new(256)
        [void][SitecadClose]::GetClassName($sitecadNativeParent, $sitecadNativeParentClass, $sitecadNativeParentClass.Capacity)
        $sitecadDiagnostic = $sitecadDiagnostic + @{ className=$sitecadCurrent.ClassName; automationId=$sitecadCurrent.AutomationId; windowHandle=$sitecadCurrent.NativeWindowHandle; patterns=$sitecadPatterns; legacyRole=$sitecadLegacyRole; controlId=[SitecadClose]::GetDlgCtrlID([IntPtr]$sitecadCurrent.NativeWindowHandle); parentHandle=$sitecadNativeParent.ToInt64(); parentClass=$sitecadNativeParentClass.ToString() }
      }
      $sitecadDiagnostics += $sitecadDiagnostic
    } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
  }
  Write-Output ('SiteCAD same-process controls: ' + (ConvertTo-Json -InputObject $sitecadDiagnostics -Compress))
  throw 'SiteCAD close confirmation did not appear'
}
if (!$sitecadProcess.WaitForExit(10000)) { throw 'SiteCAD did not exit after its close confirmation' }
if ($sitecadProcess.ExitCode -ne 0) { throw 'SiteCAD normal close returned an error' }
Write-Output 'SiteCAD close confirmation accepted; process exited normally'
