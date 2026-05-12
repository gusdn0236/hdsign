@echo off
chcp 65001 >nul
title HD사인 - 사무실용 워처 업데이트 (재빌드 + 네트워크 배포)
cd /d "%~dp0"

echo ============================================================
echo   사무실용 워처(hdsign-watcher / 지시서 자동작성) 업데이트
echo   - 이 PC 에서 재빌드
echo   - 네트워크 마스터로 배포: Z:\worksheet-program\hdsign_worksheet\
echo                            (\\Main\현대공유\worksheet-program\...)
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

echo [2/2] 빌드 + 네트워크 배포 중... (opencv 포함이라 몇 분 걸립니다)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hdsign-watcher\deploy_office.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo ============================================================
  echo   완료! 이제 각 사무실 워처 PC 에서:
  echo     1) 워처를 종료하고
  echo     2) 바탕화면 "HD사인 지시서(사무실)" 바로가기를 다시 실행
  echo   하면 변경분만 동기화되어 새 버전으로 갱신됩니다.
  echo   ^(워처가 떠 있는 채로 누르면 동기화 안 됨 - 꼭 먼저 종료^)
  echo ============================================================
) else (
  echo [에러] 빌드/배포 실패 ^(코드 %RC%^). 위 메시지를 확인하세요.
  echo        - "네트워크 공유에 접근 불가" : Z: 매핑 / 네트워크 확인
  echo        - "pip install 실패"          : 인터넷 확인
)
echo.
pause
