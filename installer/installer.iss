; DELTA — Data Validation Console — Windows installer.
; Compiled with Inno Setup 6 (ISCC.exe). See build_installer.bat.
;
; NOTE: AppVersion below and the repo-root VERSION file must be bumped
; together — there's no single source of truth (Inno's preprocessor has no
; plain-text file-read primitive), so this is a manually-kept-in-sync
; duplicate. AppVersion here also becomes the GitHub release tag (vX.Y.Z)
; that desktop_app.py's auto-updater compares against.

#define MyAppName "DELTA Data Validation Console"
#define MyAppVersion "1.0.6"
#define MyAppPublisher "Mythics LLC"
#define MyAppExeName "DeltaDataValidation.exe"

[Setup]
; Doubled opening brace is Inno's own escape for a literal "{" in a [Setup]
; value (distinct from the ISPP "{#name}" substitution syntax) — this must
; stay a fixed GUID across every future version so Windows treats upgrades
; as upgrades rather than a second, separate install.
AppId={{86CD3451-B490-4BBE-B2DF-9AA40F6FCFCD}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
; Safety net for "double-clicked Setup.exe while the app was already
; running" — the auto-update path (desktop_app.py's
; _download_and_install_worker) already closes the app itself before
; launching Setup, so in that flow this is a no-op by the time it runs.
CloseApplications=yes
CloseApplicationsFilter=*.exe
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=DeltaDataValidation_Setup
SetupIconFile=..\webapp\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardImageFile=assets\wizard_side.png,assets\wizard_side@2x.png
WizardSmallImageFile=assets\wizard_small.png,assets\wizard_small@2x.png
WizardSizePercent=100
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[InstallDelete]
; --onedir's _internal\ dependency folder can gain/lose/rename files between
; versions (e.g. a package we stop bundling) — wipe it before laying down
; the new one on upgrade so no stale file from a previous version lingers
; alongside the new build's.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
; --onedir (see build_exe.bat) — the exe plus its whole _internal\ support
; folder, not a single file. ignoreversion because these are our own build
; outputs with no meaningful per-file version stamps to compare.
Source: "..\dist\DeltaDataValidation\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; The WebView2 bootstrapper (if needed) is downloaded straight to {tmp} by
; the [Code] section below and run from there by [Run] — it never needs to
; be listed here.

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; Check: WebView2WasDownloaded; Flags: waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientKey = '\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  DownloadPage: TDownloadWizardPage;
  DidDownloadWebView2: Boolean;

function WebView2IsInstalled: Boolean;
begin
  Result :=
    RegKeyExists(HKLM, 'SOFTWARE' + WebView2ClientKey) or
    RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node' + WebView2ClientKey) or
    RegKeyExists(HKCU, 'SOFTWARE' + WebView2ClientKey);
end;

function WebView2WasDownloaded: Boolean;
begin
  Result := DidDownloadWebView2;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and (not WebView2IsInstalled) then begin
    DownloadPage.Clear;
    DownloadPage.Add(
      'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
      'MicrosoftEdgeWebview2Setup.exe', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        DidDownloadWebView2 := True;
      except
        if DownloadPage.AbortedByUser then
          Log('WebView2 download aborted by user.')
        else
          SuppressibleMsgBox(
            'Could not download the Microsoft Edge WebView2 Runtime (needed to run this app). ' +
            'You can install it manually from https://developer.microsoft.com/microsoft-edge/webview2/ ' +
            'and re-run this app afterwards.',
            mbError, MB_OK, IDOK);
        DidDownloadWebView2 := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;
