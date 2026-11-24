@echo off
title HD사인 사무실용 프로그램 설치
REM HD사인 사무실용 프로그램 설치
REM 회사 공유폴더(\\Main\현대공유 = Z:)의 바로가기를 이 PC 바탕화면에 복사하고 바로 실행합니다.
REM 프로그램 본체는 바로가기를 실행할 때마다 공유폴더에서 최신본으로 자동 갱신됩니다.
pushd "%TEMP%" >nul

set "SRC=\\Main\현대공유\worksheet-program\HD사인 지시서(사무실).lnk"
if exist "%SRC%" goto :found
set "SRC=Z:\worksheet-program\HD사인 지시서(사무실).lnk"
if exist "%SRC%" goto :found
echo.
echo [오류] 회사 공유폴더에 접근할 수 없습니다.
echo        \\Main\현대공유 (Z: 드라이브) 가 이 PC 에 연결돼 있는지 확인해주세요.
echo        회사 네트워크에 연결된 PC 에서만 설치됩니다.
echo.
pause
exit /b 1

:found
set "DESK="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%D"
if not defined DESK set "DESK=%USERPROFILE%\Desktop"

copy /Y "%SRC%" "%DESK%\" >nul
if errorlevel 1 goto :copyfail

echo.
echo  바탕화면에 [HD사인 지시서(사무실)] 바로가기를 만들었습니다.
echo  지금 바로 실행합니다. 다음부터는 바탕화면 바로가기로 실행하세요.
echo.
start "" "%DESK%\HD사인 지시서(사무실).lnk"
timeout /t 4 >nul
exit /b 0

:copyfail
echo.
echo [오류] 바탕화면에 바로가기를 복사하지 못했습니다: %DESK%
echo.
pause
exit /b 1
