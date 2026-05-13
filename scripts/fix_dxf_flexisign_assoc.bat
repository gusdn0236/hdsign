@echo off
setlocal enableextensions
title HD사인 - .dxf 를 FlexiSIGN 으로 열기 + 아이콘은 빈 종이로

echo ============================================================
echo  .dxf 더블클릭  ->  (이미 떠 있는) FlexiSIGN 에서 열기
echo  .dxf 아이콘     ->  일반 "빈 종이" 아이콘 (다른 도면 프로그램과 구분)
echo  .fs  아이콘     ->  그대로 (FlexiSIGN 로고)
echo ============================================================
echo.
echo  * CNC / Type3 / CAD 전용 PC 에서는 실행하지 마세요.
echo    (.dxf 를 FlexiSIGN 으로 여는 현장 PC 전용)
echo  * 마지막에 탐색기(파일 창)가 잠깐 닫혔다 다시 열립니다.
echo  * 네트워크(공유폴더)에서 바로 더블클릭해 실행해도 됩니다.
echo.
echo  계속하려면 아무 키나, 취소하려면 이 창을 닫으세요...
pause >nul
echo.

REM ---- 1) FlexiSIGN 의 .fs 연결(FlexiSIGN.Document) 확인 ----------------------
reg query "HKCR\FlexiSIGN.Document\shell\open\command" /ve >nul 2>&1
if errorlevel 1 (
  echo [오류] 이 PC 엔 FlexiSIGN 의 .fs 연결이 없습니다.
  echo        FlexiSIGN 으로 .fs 파일을 한 번 열어 연결을 만든 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)
for /f "tokens=2,*" %%A in ('reg query "HKCR\FlexiSIGN.Document\shell\open\command" /ve ^| find "REG_SZ"') do echo  FlexiSIGN 열기 명령 : %%B
echo.

REM ---- 2) 현재 .dxf 설정 백업 (이 PC 바탕화면에) -----------------------------
set "BKDIR=%USERPROFILE%\Desktop"
set "B1=%BKDIR%\dxf_backup_FileExts_%COMPUTERNAME%.reg"
set "B2=%BKDIR%\dxf_backup_Classes_%COMPUTERNAME%.reg"
reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.dxf" "%B1%" /y >nul 2>&1
reg export "HKCU\Software\Classes\.dxf" "%B2%" /y >nul 2>&1
echo  백업 저장 (되돌리려면 그 .reg 더블클릭 후 로그아웃/로그인):
if exist "%B1%" echo    %B1%
if exist "%B2%" echo    %B2%
echo.

REM ---- 3) .dxf 전용 ProgId(HDSign.dxf) 만들기 -------------------------------
REM        열기/DDE 동작은 FlexiSIGN.Document 의 shell 트리를 그대로 복사 = 동작 동일.
REM        DefaultIcon 만 일반 "빈 종이" 아이콘으로 덮어씀.
reg delete "HKCU\Software\Classes\HDSign.dxf" /f >nul 2>&1
reg add "HKCU\Software\Classes\HDSign.dxf" /ve /d "DXF 도면" /f >nul
reg copy "HKCR\FlexiSIGN.Document\shell" "HKCU\Software\Classes\HDSign.dxf\shell" /s /f >nul
reg add "HKCU\Software\Classes\HDSign.dxf\DefaultIcon" /ve /t REG_SZ /d "%SystemRoot%\System32\imageres.dll,-2" /f >nul

REM ---- 4) .dxf 를 이 ProgId 에 연결 ----------------------------------------
reg add "HKCU\Software\Classes\.dxf" /ve /d "HDSign.dxf" /f >nul
reg add "HKCU\Software\Classes\.dxf\OpenWithProgids" /v "HDSign.dxf" /t REG_NONE /f >nul 2>&1

REM ---- 5) 캐시된 사용자 선택(UserChoice 등) 제거 -> 위 설정 적용 ------------
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.dxf" /f >nul 2>&1
echo  완료: .dxf -> HDSign.dxf  (열기=FlexiSIGN, 아이콘=빈 종이)
echo.

REM ---- 6) 아이콘 캐시 새로고침 + 탐색기 재시작 -----------------------------
echo  탐색기 재시작 중...
ie4uinit.exe -show >nul 2>&1
taskkill /f /im explorer.exe >nul 2>&1
start "" explorer.exe
echo.

echo ============================================================
echo  끝났습니다.
echo   - .dxf 아이콘이 빈 종이로 안 바뀌면 잠시 후, 또는 로그아웃/로그인.
echo   - 더블클릭 시 "어떤 앱으로 열까요?" 가 뜨면 이 .bat 를 한 번 더 실행.
echo     (그 창에서 FlexiSIGN + "항상" 체크는 하지 마세요 - 아이콘이 로고로 되돌아갑니다.)
echo ============================================================
echo.
pause
