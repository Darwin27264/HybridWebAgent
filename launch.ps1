# Ofln-Scout One-Click PowerShell Launcher
Set-Location -Path $PSScriptRoot

Write-Host "====================================================================" -ForegroundColor Green
Write-Host "      Ofln-Scout: Starting Local System 1 + 2 Orchestrator          " -ForegroundColor Green
Write-Host "====================================================================" -ForegroundColor Green

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not found in your PATH." -ForegroundColor Red
    Write-Host "Please install Node.js v20+ to run Ofln-Scout."
    Read-Host "Press Enter to exit..."
    exit 1
}

node scripts/launch.mjs @args

