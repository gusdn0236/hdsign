@echo off
chcp 65001 >nul
REM === 1단계: 사진 다운로드용 디버그 Chrome 열기 (엔진=C:\kakao-dl 호출) ===
call "C:\kakao-dl\kakao-launch.bat"
echo.
echo 로그인하고 사진모음을 연 뒤, 2_사진_캡처다운로드.bat 를 실행하세요.
pause