@echo off
REM HD사인 현장 에이전트 PyInstaller 빌드 — onefile + noconsole.
REM 결과: dist\hdsign_field_agent.exe (단일 .exe, ~10MB).
REM 회사 PC 에 첫 배포 시 한 번만 실행.
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo [에러] Python 런처(py) 가 PATH 에 없습니다. Python 3.10+ 설치 필요.
  pause
  exit /b 1
)

py -3 -m pip install --upgrade pyinstaller
py -3 -m PyInstaller --noconfirm --onefile --noconsole ^
  --name hdsign_field_agent ^
  --icon NONE ^
  field_agent.py

if errorlevel 1 (
  echo [에러] PyInstaller 빌드 실패.
  pause
  exit /b 1
)

echo.
echo === 빌드 완료 ===
echo dist\hdsign_field_agent.exe
echo config.example.json 을 dist\ 로 복사 후 config.json 으로 이름변경하고 환경값 수정.
echo 시작프로그램 등록: shell:startup 폴더에 hdsign_field_agent.exe 바로가기 두기.
echo.
pause
