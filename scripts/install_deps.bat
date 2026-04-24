@echo off
echo HD Sign 지시서 감시 프로그램 - 의존성 설치
echo =============================================
pip install watchdog "qrcode[pil]" Pillow pywin32
echo.
echo 설치 완료. run_watcher.bat 으로 프로그램을 실행하세요.
pause
