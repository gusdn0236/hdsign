@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "OUTDIR=%~dp0illustrator_com_registry_export"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

echo === Export Illustrator COM registry keys ===
echo Output: %OUTDIR%
echo.

set "FOUND="

for /f "tokens=*" %%K in ('reg query HKCR 2^>nul ^| findstr /R /C:"\\Illustrator\.Application"') do (
    set "KEY=%%K"
    for %%P in ("!KEY!") do set "PROGID=%%~nxP"
    echo Found !PROGID!
    set "FOUND=1"

    reg export "!KEY!" "%OUTDIR%\!PROGID!.reg" /y >nul

    set "CLSID="
    for /f "tokens=2,*" %%A in ('reg query "!KEY!\CLSID" /ve 2^>nul ^| findstr /R /C:"REG_SZ"') do (
        set "CLSID=%%B"
    )

    if defined CLSID (
        echo Exporting CLSID !CLSID!
        set "SAFECLSID=!CLSID:{=!"
        set "SAFECLSID=!SAFECLSID:}=!"
        reg export "HKCR\CLSID\!CLSID!" "%OUTDIR%\CLSID_!SAFECLSID!.reg" /y >nul

        set "TYPELIB="
        for /f "tokens=2,*" %%A in ('reg query "HKCR\CLSID\!CLSID!\TypeLib" /ve 2^>nul ^| findstr /R /C:"REG_SZ"') do (
            set "TYPELIB=%%B"
        )

        if defined TYPELIB (
            echo Exporting TypeLib !TYPELIB!
            set "SAFETYPELIB=!TYPELIB:{=!"
            set "SAFETYPELIB=!SAFETYPELIB:}=!"
            reg export "HKCR\TypeLib\!TYPELIB!" "%OUTDIR%\TypeLib_!SAFETYPELIB!.reg" /y >nul
        )
    )
)

if not defined FOUND (
    echo No Illustrator.Application ProgID was found on this PC.
    echo Run this on a PC where the watcher already works with Illustrator.
    pause
    exit /b 1
)

(
echo @echo off
echo setlocal
echo net session ^>nul 2^>nul
echo if errorlevel 1 ^(
echo   echo Run this file as Administrator.
echo   pause
echo   exit /b 1
echo ^)
echo echo === Import Illustrator COM registry keys ===
echo for %%%%F in ^("%%~dp0*.reg"^) do ^(
echo   echo Importing %%%%~nxF
echo   reg import "%%%%~fF"
echo   if errorlevel 1 ^(
echo     echo Failed: %%%%~fF
echo     pause
echo     exit /b 1
echo   ^)
echo ^)
echo echo.
echo echo Import complete.
echo echo Close Illustrator, start Illustrator once, then start hdsign_worksheet.exe.
echo pause
) > "%OUTDIR%\import_illustrator_com_registry_as_admin.bat"

echo.
echo Export complete.
echo Copy this whole folder to the problem PC:
echo   %OUTDIR%
echo.
echo On the problem PC, right-click import_illustrator_com_registry_as_admin.bat
echo and choose "Run as administrator".
pause
