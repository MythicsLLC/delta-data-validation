@echo off
REM Builds a single-file Windows .exe for the DELTA Data Validation Console.
REM Run from the repo root. Output: dist\DeltaDataValidation.exe
REM
REM Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 11
REM and most updated Windows 10 machines). The UI is plain HTML/CSS/JS in
REM webapp\, rendered via pywebview's edgechromium backend — no Chromium is
REM bundled, so the exe stays a fraction of the size an Electron-style app
REM would be.
REM
REM NOTE on excludes: --collect-all polars pulls in polars' optional cloud-
REM storage extras (S3/boto3, SQL/sqlalchemy, SSH/paramiko, etc.) which this
REM app never uses since it only reads local files. Excluding them keeps the
REM bundle smaller, which matters because PyInstaller onefile re-extracts the
REM whole archive to a temp dir on every launch, and antivirus real-time
REM scanning of that extraction is the dominant cost of first-launch delay.

setlocal
cd /d "%~dp0"

echo Cleaning previous build artifacts...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist DeltaDataValidation.spec del /q DeltaDataValidation.spec
if exist DeltaPostValidation.spec del /q DeltaPostValidation.spec

echo Building single-file exe with PyInstaller...
python -m PyInstaller ^
    --onefile ^
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
echo Build succeeded: dist\DeltaDataValidation.exe
echo NOTE: first launch self-extracts the bundle to a temp folder and may take
echo a few seconds to a minute (longer if antivirus real-time scanning is slow)
echo before the window appears. This is normal for single-file PyInstaller apps
echo and is a one-time cost per unique build (see README.md).
endlocal
