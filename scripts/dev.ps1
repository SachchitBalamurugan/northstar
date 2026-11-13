# Start memory (:7701) and inbox (:7702) in two PowerShell windows. Usage: .\scripts\dev.ps1
$root = Split-Path -Parent $PSScriptRoot
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$root\memory'; uv run uvicorn main:app --port 7701 --reload"
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$root\inbox'; npm run dev"
Write-Host "memory -> http://127.0.0.1:7701/health   inbox -> http://127.0.0.1:7702/health"
