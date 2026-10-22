@echo off
REM Double-click to start. Keep this file ASCII-only: cmd.exe reads .bat/.cmd in the
REM system code page, so UTF-8 Chinese here would be garbled (messages live in tools\launch.mjs).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22.6+ from https://nodejs.org/ first.
  pause
  exit /b 1
)

node tools\launch.mjs
if errorlevel 1 pause
