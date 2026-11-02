#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppDirectory
  #error AppDirectory is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif

[Setup]
AppId={{B6F423F2-D86D-44E4-B30F-985FCD3B819A}
AppName=SiteCAD
AppVersion={#AppVersion}
AppPublisher=SiteCAD contributors
DefaultDirName={localappdata}\Programs\SiteCAD
DefaultGroupName=SiteCAD
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDirectory}
OutputBaseFilename=SiteCAD-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\SiteCAD.exe
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
LicenseFile={#AppDirectory}\resources\app\LICENSE

[Files]
Source: "{#AppDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\SiteCAD"; Filename: "{app}\SiteCAD.exe"
Name: "{autodesktop}\SiteCAD"; Filename: "{app}\SiteCAD.exe"
