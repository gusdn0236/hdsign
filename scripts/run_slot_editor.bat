@echo off
REM 1회용 슬롯 좌표 편집기 — distribution.jpg 위 박스를 드래그/키보드로 조정.
REM 콘솔 창은 띄우되(에러 메시지 보이게) 편집기 창은 별도 토플레벨로 띄움.
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
"%PYTHON%" "%~dp0_slot_editor.py"
pause
