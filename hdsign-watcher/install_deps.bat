@echo off
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
"%PYTHON%" -m pip install watchdog qrcode[pil] Pillow pywin32 pymupdf pyzbar
echo.
echo Done. Run run_watcher.bat to start.
pause
