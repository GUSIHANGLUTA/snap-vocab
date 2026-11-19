@echo off
REM Start in iPad/phone mode: the server also listens on the LAN so an iPad on the
REM same Wi-Fi can open http://<this-pc-ip>:8910 . ASCII only on purpose.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22.6+ from https://nodejs.org/ first.
  pause
  exit /b 1
)

node tools\launch.mjs --lan
if errorlevel 1 pause
