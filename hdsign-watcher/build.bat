@echo off
setlocal
set SCRIPT_DIR=%~dp0
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
REM --onedir 결과 폴더(이전 --onefile 시 단일 .exe). 시작 시간을 줄이려고 onedir 로 전환.
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

REM --onedir 출력 폴더(`dist\hdsign_worksheet\`) 통째로 정리한다.
REM 폴더 안에 EXE + 수백 개 DLL/asset 이 있어 PyInstaller 가 새로 채울 때 잔재가 남으면 충돌.
REM 옛 onefile 잔재(`dist\hdsign_worksheet.exe`, `.old_*.exe`) 도 함께 청소.
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
"%PYTHON%" -m pip install pyinstaller watchdog "qrcode[pil]" Pillow pywin32 pymupdf pyzbar
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
REM --onedir + --noupx : 시작 시간 단축. onefile 은 매 실행마다 100MB+ 압축 묶음을
REM 임시 폴더에 풀어서 5~15초가 걸렸음. onedir 는 풀린 상태로 두고 EXE 만 실행 → 1~3초.
REM UPX 압축도 끔 — EXE 크기는 늘지만 디스크/네트워크에서 한 번 받으면 OS 캐시가 처리.
"%PYTHON%" -m PyInstaller --clean -y --onedir --windowed --noupx --name hdsign_worksheet --collect-all pymupdf --collect-all pyzbar --hidden-import fitz --hidden-import pyzbar --hidden-import pyzbar.pyzbar --hidden-import encodings.idna --add-data "%SCRIPT_DIR%assets\distribution.jpg;assets" "%SCRIPT_DIR%hdsign_watcher.py"
if errorlevel 1 (
    echo.
    echo [ERROR] PyInstaller build failed. See output above.
    popd
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Output folder: %TARGET_DIR%
echo  EXE          : %TARGET%
echo.
echo  배포 — \\Main\현대공유\지시서프로그램 에 'hdsign_worksheet' 폴더
echo  통째로 복사. 바로가기 대상은 폴더 안의 hdsign_worksheet.exe.
echo  옛 단일 EXE (지시서프로그램\hdsign_worksheet.exe) 가 있으면 삭제.
echo ============================================================
popd
pause
