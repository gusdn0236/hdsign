@echo off
title HD사인 지시서 업데이트 중...
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
    echo HD사인 지시서 프로그램 업데이트 중...
    echo 잠시만 기다려주세요.
    robocopy "%SRC%" "%DST%" /MIR /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    if errorlevel 8 (
        echo [경고] 네트워크 업데이트 실패 - 이전 버전으로 실행합니다.
    )
) else (
    echo [경고] 마스터 폴더에 접근할 수 없습니다 - 이전 버전으로 실행합니다.
    echo        %SRC%
    echo        이 PC 에 Z: 드라이브가 매핑돼 있는지 확인해주세요.
)

if not exist "%EXE%" (
    echo.
    echo [오류] hdsign_worksheet.exe 를 찾을 수 없습니다:
    echo   %EXE%
    echo 마스터 폴더에 접근 가능한지 확인해주세요:
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
