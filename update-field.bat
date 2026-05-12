@echo off
chcp 65001 >nul
title HD사인 - 현장용 에이전트 업데이트 (재빌드 + 네트워크 배포)
cd /d "%~dp0"

echo ============================================================
echo   현장용 에이전트(field-agent / FlexiSIGN 사이드바) 업데이트
echo   - 이 PC 에서 재빌드 (정식 + 디버그)
echo   - 네트워크 배포: Z:\field-agent\dist\
echo                   (\\Main\현대공유\field-agent\dist\)
echo   * config.json / 바로가기(.lnk) 는 건드리지 않습니다.
echo ============================================================
echo.

echo [1/2] 최신 코드 받기 (git pull)...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo   [경고] git pull 실패 또는 git 없음 - 현재 작업트리 그대로 빌드합니다.
  echo          의도한 게 아니면 지금 이 창을 닫으세요. 5초 후 계속...
  timeout /t 5 >nul
)
echo.

echo [2/2] 빌드 + 네트워크 배포 중...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0field-agent\deploy_field.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo ============================================================
  echo   완료! 이제 각 현장/사무실 직원 PC 에서:
  echo     - 바탕화면 "HD사인 지시서 (현장)" 바로가기를 다시 실행
  echo       ^(사이드바가 떠 있으면 닫았다 다시 열기 - 그래야 새 .exe 적용^)
  echo   * .exe 직접 더블클릭 금지 - 반드시 .lnk ^(launcher.vbs^)
  echo ============================================================
) else (
  echo [에러] 빌드/배포 실패 ^(코드 %RC%^). 위 메시지를 확인하세요.
  echo        - "복사 실패 ... 잠김" : 그 .exe 를 쓰는 현장 PC 의 사이드바를
  echo          닫은 뒤 이 .bat 를 다시 실행하세요.
  echo        - "네트워크 공유에 접근 불가" : Z: 매핑 / 네트워크 확인
)
echo.
pause
