@echo off
REM Builds dist\DeltaDataValidation_Setup.exe — the distributable installer.
REM Run from this directory (StandaloneApp\installer\). Requires the app exe
REM to already be built (run ..\build_exe.bat first) and Inno Setup 6
REM installed (ISCC.exe on PATH, or one of the common install locations
REM below).

setlocal
cd /d "%~dp0"

if not exist "..\dist\DeltaDataValidation.exe" (
    echo ERROR: ..\dist\DeltaDataValidation.exe not found — run ..\build_exe.bat first.
    exit /b 1
)

set ISCC=iscc.exe
where %ISCC% >nul 2>nul
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" (
        set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
    ) else if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
        set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
    ) else (
        echo ERROR: ISCC.exe not found. Install Inno Setup 6 ^(https://jrsoftware.org/isinfo.php^).
        exit /b 1
    )
)

echo Regenerating wizard art from favicon.png...
python gen_assets.py
if errorlevel 1 (
    echo BUILD FAILED: could not generate wizard assets.
    exit /b 1
)

echo Compiling installer with %ISCC%...
"%ISCC%" installer.iss
if errorlevel 1 (
    echo BUILD FAILED.
    exit /b 1
)

echo.
echo Build succeeded: dist\DeltaDataValidation_Setup.exe
endlocal
