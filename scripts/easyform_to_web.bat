@echo off
title 이지폼 → 홈페이지 명세서
py -3 "%~dp0easyform_to_web.py"
timeout /t 4 >nul
