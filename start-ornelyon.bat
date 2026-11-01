@echo off
rem ORNELYON launcher for Windows. No administrator rights are needed.
rem Requires Node.js 20 or newer (https://nodejs.org). Nothing is installed globally.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 20 LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

node dist\interface\cli.js gui
if errorlevel 1 pause
