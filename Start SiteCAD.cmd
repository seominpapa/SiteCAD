@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-local-web.ps1"
set "SITECAD_EXIT=%ERRORLEVEL%"
if not "%SITECAD_EXIT%"=="0" (
  echo.
  echo SiteCAD setup or startup failed. Review the error above, then try again.
  pause
)
exit /b %SITECAD_EXIT%
