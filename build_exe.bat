@echo off
REM Builds the DELTA Data Validation Console as a PyInstaller --onedir build.
REM Run from the repo root. Output: dist\DeltaDataValidation\DeltaDataValidation.exe
REM (plus its supporting _internal\ folder — see installer\installer.iss,
REM which packages the whole folder, not just the exe).
REM
REM Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 11
REM and most updated Windows 10 machines). The UI is plain HTML/CSS/JS in
REM webapp\, rendered via pywebview's edgechromium backend — no Chromium is
REM bundled, so the exe stays a fraction of the size an Electron-style app
REM would be.
REM
REM NOTE on --onedir (not --onefile): a --onefile exe re-extracts its entire
REM bundle to a fresh %TEMP% folder on *every single launch*, and antivirus
REM real-time scanning of that freshly-written extraction was the dominant
REM cost of the "10s-60s before the window appears" first-launch delay this
REM app used to have (see git history / README). --onedir writes the files
REM once, at install time, and every launch after that just runs them
REM directly — no per-launch extraction, so no per-launch AV re-scan. This
REM only works well because distribution goes through installer\installer.iss
REM now instead of handing someone a bare .exe; a loose folder next to a
REM .exe would be a worse "download this" experience than one file.
REM
REM NOTE on excludes: --collect-all polars pulls in polars' optional cloud-
REM storage extras (S3/boto3, SQL/sqlalchemy, SSH/paramiko, etc.) which this
REM app never uses since it only reads local files. Excluding them keeps the
REM install smaller for no functional loss.

setlocal
cd /d "%~dp0"

echo Cleaning previous build artifacts...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist DeltaDataValidation.spec del /q DeltaDataValidation.spec
if exist DeltaPostValidation.spec del /q DeltaPostValidation.spec

echo Building DeltaDataValidation (--onedir) with PyInstaller...
python -m PyInstaller ^
    --onedir ^
    --noconsole ^
    --name DeltaDataValidation ^
    --icon "webapp\assets\icon.ico" ^
    --add-data "webapp;webapp" ^
    --add-data "VERSION;." ^
    --collect-all polars ^
    --collect-all python_calamine ^
    --collect-all fastexcel ^
    --collect-all xlsxwriter ^
    --collect-all openpyxl ^
    --collect-all webview ^
    --hidden-import pandas ^
    --hidden-import clr_loader ^
    --hidden-import pythonnet ^
    --exclude-module matplotlib ^
    --exclude-module boto3 ^
    --exclude-module botocore ^
    --exclude-module s3transfer ^
    --exclude-module sqlalchemy ^
    --exclude-module paramiko ^
    --exclude-module psycopg2 ^
    --exclude-module psycopg ^
    --exclude-module psycopg_binary ^
    --exclude-module dns ^
    --exclude-module spnego ^
    --exclude-module sspilib ^
    --exclude-module win32com ^
    --exclude-module IPython ^
    --exclude-module pytest ^
    desktop_app.py

if errorlevel 1 (
    echo BUILD FAILED.
    exit /b 1
)

echo.
echo Build succeeded: dist\DeltaDataValidation\DeltaDataValidation.exe
echo Run installer\build_installer.bat next to produce a distributable Setup.exe.
endlocal
