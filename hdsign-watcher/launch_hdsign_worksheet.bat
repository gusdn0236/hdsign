@echo off
REM HD Sign Worksheet launcher.
REM Master location: Z:\worksheet-program\launch_hdsign_worksheet.bat
REM (Each PC must have Z: mapped to \\Main\hyundai-share-root.)
REM Each PC desktop shortcut should target THIS .bat file.
REM First launch: full copy from master (slow, ~30s).
REM Subsequent launches: only changed files (instant).

REM Switch CWD to a local folder so cmd does not complain about UNC.
pushd "%TEMP%" >nul

set "SRC=Z:\worksheet-program\hdsign_worksheet"
set "DST=C:\HDSign\hdsign_worksheet"
set "EXE=%DST%\hdsign_worksheet.exe"

REM If already running, do nothing (avoid double-launch + robocopy lock).
tasklist /FI "IMAGENAME eq hdsign_worksheet.exe" 2>nul | find /I "hdsign_worksheet.exe" >nul
if %ERRORLEVEL%==0 exit /b 0

if not exist "%DST%" mkdir "%DST%"

if exist "%SRC%" (
    echo Syncing worksheet program from network...
    robocopy "%SRC%" "%DST%" /MIR /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    if errorlevel 8 (
        echo [WARN] Network sync failed. Launching last local copy.
    )
) else (
    echo [WARN] Master folder not reachable - launching last local copy.
    echo        %SRC%
    echo        Check that drive Z: is mapped on this PC.
)

if not exist "%EXE%" (
    echo.
    echo [ERROR] hdsign_worksheet.exe not found at:
    echo   %EXE%
    echo Check that the master folder is reachable:
    echo   %SRC%
    pause
    exit /b 1
)

REM --- Self-heal the desktop shortcut so it ALWAYS shows the HD Sign logo ---
REM The .ico ships inside the program folder (PyInstaller bundles data files under
REM _internal\), so after the sync above this path is guaranteed to exist locally.
REM We (re)point every desktop shortcut that targets this .bat at that .ico, and
REM create one if none exists yet.
set "ICO=%DST%\_internal\hdsign_worksheet.ico"
set "THISBAT=%~f0"
if exist "%ICO%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ico='%ICO%'; $bat='%THISBAT%'; $sh=New-Object -ComObject WScript.Shell;" ^
      "$desk=[Environment]::GetFolderPath('Desktop'); $found=$false;" ^
      "Get-ChildItem -Path $desk -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {" ^
      "  $l=$sh.CreateShortcut($_.FullName);" ^
      "  if ($l.TargetPath -ieq $bat) { $found=$true; if ($l.IconLocation -ne ($ico+',0')) { $l.IconLocation=$ico+',0'; $l.Save() } }" ^
      "};" ^
      "if (-not $found) { $l=$sh.CreateShortcut((Join-Path $desk 'HD Sign Worksheet.lnk')); $l.TargetPath=$bat; $l.WorkingDirectory=(Split-Path $bat); $l.IconLocation=$ico+',0'; $l.Save() }" 2>nul
)

start "" "%EXE%"
exit /b 0