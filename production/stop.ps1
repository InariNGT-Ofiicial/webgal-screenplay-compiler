$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$statePath = Join-Path $packageRoot 'build\service\service.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No recorded service.'; exit }
$serviceState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($serviceState.port)/api/health" -TimeoutSec 2 } catch { Write-Host 'Service is already stopped.'; exit }
if ($health.instanceRoot -eq $packageRoot -and $health.processId -eq $serviceState.processId) {
    Stop-Process -Id $serviceState.processId -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    Write-Host 'Service stopped.'
} else { Write-Host 'Port belongs to another service; leaving it running.' }
