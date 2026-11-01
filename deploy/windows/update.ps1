# Pulls the latest version from GitHub and restarts the app. Your data and config.env are not touched.
param()

. (Join-Path $PSScriptRoot 'elevate.ps1')
if (Restart-Elevated $PSCommandPath $PSBoundParameters) { exit }
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed - nothing was changed or restarted.' }

# Whatever happens while stopping, always start the app again afterwards.
try {
    & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
} catch {
    Write-Warning "While stopping: $($_.Exception.Message) - starting the app anyway."
} finally {
    Start-ScheduledTask -TaskName 'BlevingPlanner'
}

# Confirm it actually answers before saying so (it can take a few seconds to start).
$port = 3000
$portLine = Select-String -Path (Join-Path $root 'config.env') -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/session" -TimeoutSec 3
        $ok = $true
    } catch { }
}
if ($ok) {
    Write-Host 'Updated and restarted - the app is running.' -ForegroundColor Green
} else {
    Write-Warning "Updated, but the app is not answering on port $port. Look in $root\logs\server-error.log"
}
