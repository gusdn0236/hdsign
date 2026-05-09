@echo off
REM HD사인 현장 작업뷰어 에이전트 — 개발/디버깅용 콘솔 실행.
REM 정식 배포는 PyInstaller 로 .exe 빌드 후 시작프로그램에 등록한다(별도 빌드 스크립트 예정).
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo [에러] Python 런처(py) 가 PATH 에 없습니다. Python 3.10+ 설치 필요.
  pause
  exit /b 1
)
py -3 field_agent.py
pause
