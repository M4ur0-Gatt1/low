; Instalador de Fidel â€” editor de cÃ³digo con agente IA
; Compilar: ISCC.exe fidel_installer.iss

#define AppName "Fidel"
#define AppVersion "2.18.0"
#define AppExe "Fidel.exe"

[Setup]
AppId={{B7E3D9A4-2C51-4F8E-A6B0-3D94E71C5F28}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Mauro Gatti
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; instalaciÃ³n por usuario: no pide permisos de administrador
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=FidelSetup-{#AppVersion}
SetupIconFile=fidel.ico
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
; la config y el historial quedan en %APPDATA%\Fidel por si reinstala;
; solo se borra lo instalado
Type: filesandordirs; Name: "{app}"

