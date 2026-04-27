@echo off
setlocal
set SCRIPT_DIR=%~dp0
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
set TARGET=%SCRIPT_DIR%dist\hdsign_worksheet.exe

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

REM Try delete first; if locked, fall back to renaming the .exe out of the way.
REM Windows allows renaming an open .exe even when delete is blocked, which lets
REM PyInstaller write a fresh .exe at the original path.
if exist "%TARGET%" (
    del /F /Q "%TARGET%" >nul 2>nul
)
if exist "%TARGET%" (
    ren "%TARGET%" "hdsign_worksheet.old_%RANDOM%.exe" >nul 2>nul
)
if exist "%TARGET%" (
    echo.
    echo [!] Cannot delete OR rename "%TARGET%".
    echo     Possible causes:
    echo       - Watcher still running with elevated privileges - kill it in Task Manager
    echo       - Anti-virus is locking the file
    echo       - Run build_exe.bat as administrator
    popd
    pause
    exit /b 1
)

REM Tidy up any .old_*.exe leftovers from previous rename fallbacks.
del /F /Q "%SCRIPT_DIR%dist\hdsign_worksheet.old_*.exe" >nul 2>nul

if exist "%SCRIPT_DIR%hdsign_worksheet.spec" del "%SCRIPT_DIR%hdsign_worksheet.spec"
if exist "%SCRIPT_DIR%hdsign_watcher.spec" del "%SCRIPT_DIR%hdsign_watcher.spec"
if exist "%SCRIPT_DIR%build" rmdir /s /q "%SCRIPT_DIR%build"
if exist "%SCRIPT_DIR%dist" rmdir /s /q "%SCRIPT_DIR%dist"

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
REM into the onefile bundle. Without this, fitz.open() can fail in the built .exe
REM even though "import fitz" succeeds.
REM --collect-all pyzbar : pyzbar ships libzbar-64.dll as a native binary; without
REM this the import succeeds but decode silently returns nothing, and the watcher
REM treats every print as "QR match failed".
"%PYTHON%" -m PyInstaller --clean -y --onefile --windowed --name hdsign_worksheet --collect-all pymupdf --collect-all pyzbar --hidden-import fitz --hidden-import pyzbar --hidden-import pyzbar.pyzbar --add-data "%SCRIPT_DIR%assets\distribution.jpg;assets" "%SCRIPT_DIR%hdsign_watcher.py"
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
echo  Output: %SCRIPT_DIR%dist\hdsign_worksheet.exe
echo ============================================================
popd
pause
