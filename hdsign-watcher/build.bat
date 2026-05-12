@echo off
setlocal
set SCRIPT_DIR=%~dp0
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
REM --onedir output folder. Was a single EXE under --onefile.
set TARGET_DIR=%SCRIPT_DIR%dist\hdsign_worksheet
set TARGET=%TARGET_DIR%\hdsign_worksheet.exe

echo ============================================================
echo  HD Sign Watcher - EXE BUILD
echo  SCRIPT_DIR = %SCRIPT_DIR%
echo  PYTHON     = %PYTHON%
echo ============================================================
echo.

REM Check Python exists - earlier this could fail silently and the window closed.
if not exist "%PYTHON%" (
    echo [ERROR] Python interpreter not found at:
    echo   %PYTHON%
    echo.
    echo If Python 3.9 is installed elsewhere, edit the PYTHON= line in this .bat.
    echo.
    pause
    exit /b 1
)

pushd "%SCRIPT_DIR%"
if errorlevel 1 (
    echo [ERROR] pushd failed: "%SCRIPT_DIR%"
    pause
    exit /b 1
)

REM Stop any running watcher so PyInstaller can overwrite the existing .exe.
REM /F forces, /T also kills child processes. Errors are suppressed via 2 nul.
taskkill /F /IM hdsign_worksheet.exe /T >nul 2>nul

REM --onedir output folder dist\hdsign_worksheet\ - clean it whole.
REM Old onefile leftovers (dist\hdsign_worksheet.exe, .old_*.exe) cleaned below.
if exist "%TARGET_DIR%" (
    rmdir /s /q "%TARGET_DIR%" >nul 2>nul
)
if exist "%TARGET_DIR%" (
    echo.
    echo [!] Cannot remove "%TARGET_DIR%".
    echo     Possible causes:
    echo       - Watcher still running with elevated privileges - kill it in Task Manager
    echo       - Anti-virus is locking the folder
    echo       - Run build_exe.bat as administrator
    popd
    pause
    exit /b 1
)
del /F /Q "%SCRIPT_DIR%dist\hdsign_worksheet.exe" >nul 2>nul
del /F /Q "%SCRIPT_DIR%dist\hdsign_worksheet.old_*.exe" >nul 2>nul

if exist "%SCRIPT_DIR%hdsign_worksheet.spec" del "%SCRIPT_DIR%hdsign_worksheet.spec"
if exist "%SCRIPT_DIR%hdsign_watcher.spec" del "%SCRIPT_DIR%hdsign_watcher.spec"
if exist "%SCRIPT_DIR%build" rmdir /s /q "%SCRIPT_DIR%build"
REM Keep the dist folder itself - we already taskkill + del + rename-fallback
REM the .exe above, and PyInstaller overwrites the new .exe into the same dist
REM folder. Preserves any companion files the user may have placed in dist.

echo.
echo === Ensuring dependencies are installed ===
echo.
REM No --upgrade: keep whatever pymupdf is already installed. Newer pymupdf
REM gives better QR / PDF rendering, the user accepts the larger bundle size.
REM opencv-python-headless: pyzbar(zbar) 와 다른 QR 디코더(cv2.QRCodeDetector) — 한쪽이
REM 놓친 인쇄→PDF24 경유 QR 을 다른 쪽이 잡아 인식률을 끌어올린다. -headless 는 GUI 의존이
REM 없어 번들이 가볍다. 미설치여도 워처는 cv2=None 으로 정상 동작(인식 보강만 비활성).
"%PYTHON%" -m pip install pyinstaller watchdog "qrcode[pil]" Pillow pywin32 pymupdf pyzbar opencv-python-headless
if errorlevel 1 (
    echo.
    echo [ERROR] Dependency install failed. See pip output above.
    popd
    pause
    exit /b 1
)

echo.
echo === Running PyInstaller ===
echo.
REM --collect-all pymupdf : pull all of pymupdf's modules, data files and native DLLs
REM into the bundle. Without this, fitz.open() can fail in the built .exe
REM even though "import fitz" succeeds.
REM --collect-all pyzbar : pyzbar ships libzbar-64.dll as a native binary; without
REM this the import succeeds but decode silently returns nothing, and the watcher
REM treats every print as "QR match failed".
REM No --uac-admin: keep the exe at asInvoker (default) so it can run at either
REM standard or admin level. Elevation is controlled per-shortcut by the deploy
REM script, which creates one standard shortcut and one admin-flagged shortcut.
REM --onedir + --noupx : faster startup. Onefile unpacked 100MB+ to temp every
REM launch (5-15s). Onedir keeps everything extracted, only the small EXE runs (1-3s).
REM UPX compression off too - EXE is bigger but OS cache handles it after first load.
REM --collect-all cv2 : opencv 는 native .pyd + DLL 묶음이라 collect-all 이 안전. 미설치면
REM PyInstaller 가 조용히 건너뛰므로 빌드 실패하지 않는다(런타임 cv2=None).
"%PYTHON%" -m PyInstaller --clean -y --onedir --windowed --noupx --name hdsign_worksheet --icon "%SCRIPT_DIR%hdsign_worksheet.ico" --collect-all pymupdf --collect-all pyzbar --collect-all cv2 --hidden-import fitz --hidden-import pyzbar --hidden-import pyzbar.pyzbar --hidden-import cv2 --hidden-import numpy --hidden-import encodings.idna --add-data "%SCRIPT_DIR%assets\distribution.jpg;assets" --add-data "%SCRIPT_DIR%hdsign_worksheet.ico;." "%SCRIPT_DIR%hdsign_watcher.py"
if errorlevel 1 (
    echo.
    echo [ERROR] PyInstaller build failed. See output above.
    popd
    pause
    exit /b 1
)

echo.
echo === Bundling SumatraPDF (if present alongside this script) ===
REM Drop SumatraPDF.exe + SumatraPDF-settings.txt into hdsign-watcher\ once;
REM every subsequent build copies them next to hdsign_worksheet.exe so the
REM watcher's find_sumatra_exe() finds it without manual deploy steps.
if exist "%SCRIPT_DIR%SumatraPDF.exe" (
    copy /Y "%SCRIPT_DIR%SumatraPDF.exe" "%TARGET_DIR%\" >nul
    echo  [bundled] SumatraPDF.exe
) else (
    echo  [skip] SumatraPDF.exe not found in %SCRIPT_DIR%
)
if exist "%SCRIPT_DIR%SumatraPDF-settings.txt" (
    copy /Y "%SCRIPT_DIR%SumatraPDF-settings.txt" "%TARGET_DIR%\" >nul
    echo  [bundled] SumatraPDF-settings.txt
)

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Output folder: %TARGET_DIR%
echo  EXE          : %TARGET%
echo.
echo  Deploy: copy the WHOLE 'hdsign_worksheet' folder under dist
echo  to \\Main\HD-share\Worksheet-Program\ . Update each PC shortcut
echo  target to ...\hdsign_worksheet\hdsign_worksheet.exe (subfolder).
echo  Delete the old single EXE if it remains in the share root.
echo ============================================================
popd
pause
