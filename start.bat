@echo off
chcp 65001 >nul
cd /d "%~dp0"
python serverpp.py
pause
