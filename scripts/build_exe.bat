@echo off
set PYTHON=C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe
if exist "%~dp0hdsign_worksheet.spec" del "%~dp0hdsign_worksheet.spec"
if exist "%~dp0hdsign_watcher.spec" del "%~dp0hdsign_watcher.spec"
if exist "%~dp0build" rmdir /s /q "%~dp0build"
if exist "%~dp0dist" rmdir /s /q "%~dp0dist"
"%PYTHON%" -m pip install pyinstaller
"%PYTHON%" -m PyInstaller --clean -y --onefile --windowed --name hdsign_worksheet "%~dp0hdsign_watcher.py"
echo.
echo Done. Output: dist\hdsign_worksheet.exe
pause
