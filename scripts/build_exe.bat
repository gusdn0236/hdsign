@echo off
echo HD Sign 지시서 감시 프로그램 - EXE 빌드
echo =========================================
echo PyInstaller 설치 확인 중...
pip install pyinstaller

echo.
echo EXE 빌드 중...
pyinstaller --onefile --console --name hdsign_watcher "%~dp0hdsign_watcher.py"

echo.
echo 완료! dist\hdsign_watcher.exe 파일을 사무용 PC에 복사하여 실행하세요.
pause
