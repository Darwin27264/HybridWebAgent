@echo off
setlocal
cd /d "%~dp0"
title Ofln-Scout Launcher

echo ====================================================================
echo       Ofln-Scout: Starting Local System 1 + 2 Orchestrator
echo ====================================================================
echo.

node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Node.js is not found in your PATH.
  echo Please install Node.js v20+ to run Ofln-Scout.
  echo.
  pause
  exit /b 1
)

node scripts/launch.mjs %*
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [Notice] Launcher exited with code %ERRORLEVEL%.
  pause
)

