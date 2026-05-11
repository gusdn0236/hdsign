@echo off
REM HD사인 현장 에이전트 디버그 빌드 — 콘솔창 + 파일 로그.
REM 현장 PC 에서 실행 시 까만 cmd 창이 뜨고 에러를 그대로 보여줌.
REM 정상 동작 확인되면 build.bat (--noconsole) 로 다시 빌드해 배포.
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo [에러] Python 런처(py) 가 PATH 에 없습니다.
  pause
  exit /b 1
)

py -3 -m PyInstaller --noconfirm --onefile --console ^
  --name hdsign_field_agent_debug ^
  --icon NONE ^
  field_agent.py

if errorlevel 1 (
  echo [에러] PyInstaller 빌드 실패.
  pause
  exit /b 1
)

echo.
echo === 디버그 빌드 완료 ===
echo dist\hdsign_field_agent_debug.exe
echo 현장 PC 에서 더블클릭 → 콘솔창에서 에러 메시지 확인.
echo.
pause
