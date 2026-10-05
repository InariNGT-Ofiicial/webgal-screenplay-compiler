param([switch]$NoBrowser, [int]$Port = 8895)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$gameUrl = "http://127.0.0.1:$Port/"
$logRoot = Join-Path $packageRoot 'build\service'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
function Read-GameHealth { try { Invoke-RestMethod -Uri ($gameUrl + 'api/health') -TimeoutSec 1 } catch { $null } }
$health = Read-GameHealth
if ($health) {
    if ($health.instanceRoot -ne $packageRoot) { throw "Port $Port belongs to another project." }
} else {
    $nodeRuntime = Get-Command node.exe -ErrorAction Stop
    $serverPath = Join-Path $packageRoot 'tools\serve.mjs'
    $distPath = Join-Path $packageRoot 'webgal\dist'
    if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html'))) { throw 'Install a WebGAL distribution in webgal/dist first.' }
    $previousPort = $env:PORT
    try {
        $env:PORT = "$Port"
        $service = Start-Process -FilePath $nodeRuntime.Source -ArgumentList ('"' + $serverPath + '" "' + $distPath + '"') -WorkingDirectory $packageRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'server.log') -RedirectStandardError (Join-Path $logRoot 'server-error.log')
    } finally { $env:PORT = $previousPort }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        $health = Read-GameHealth
        if ($health -and $health.instanceRoot -eq $packageRoot) { break }
        if ($service.HasExited) { break }
    }
    if (-not $health -or $health.instanceRoot -ne $packageRoot) { if (-not $service.HasExited) { Stop-Process -Id $service.Id -ErrorAction SilentlyContinue }; throw 'Service failed to start. See build/service/server-error.log.' }
}
@{processId=$health.processId;root=$packageRoot;port=$Port} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'service.json') -Encoding UTF8
Write-Host "Game running: $gameUrl"
if (-not $NoBrowser) { Start-Process $gameUrl }
