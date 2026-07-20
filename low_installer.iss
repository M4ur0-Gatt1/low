; Instalador de LOW — editor de diseño/animación con agente IA
; Compilar: ISCC.exe low_installer.iss

#define AppName "LOW"
; La versión se puede pasar por línea de comandos: ISCC /DAppVersion=3.5.0
; (el workflow la deriva del tag). El default acá es solo para builds manuales
; y debe coincidir con LOW_VERSION en main.py.
#ifndef AppVersion
  #define AppVersion "3.22.3"
#endif
#define AppExe "LOW.exe"

[Setup]
AppId={{B7E3D9A4-2C51-4F8E-A6B0-3D94E71C5F28}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Mauro Gatti · Tropa Circa
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; instalaciÃ³n por usuario: no pide permisos de administrador
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=LOWSetup-{#AppVersion}
SetupIconFile=low.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; la config y el historial quedan en %APPDATA%\LOW por si reinstala;
; solo se borra lo instalado
Type: filesandordirs; Name: "{app}"

