# Restarts the meal planner and checks it answers afterwards.
# Works WITHOUT administrator rights (also over SSH): it asks the background runner to do the restart.
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'elevate.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$requestFile = Join-Path $root 'restart.request'
$versionFile = Join-Path $root 'logs\runner.version'

$runnerVersion = 0
if (Test-Path $versionFile) { [void][int]::TryParse((Get-Content $versionFile -Raw).Trim(), [ref]$runnerVersion) }

if ($runnerVersion -ge 2) {
    # Ask the runner (running as SYSTEM) to restart Node, and wait until it has picked the request up.
    Set-Content -Path $requestFile -Value (Get-Date -Format s)
    Write-Host 'Restarting the app...'
    $picked = $false
    for ($i = 0; $i -lt 20 -and -not $picked; $i++) {
        Start-Sleep -Seconds 1
        $picked = -not (Test-Path $requestFile)
    }
    if (-not $picked) {
        Remove-Item $requestFile -Force -ErrorAction SilentlyContinue
        Write-Warning 'The background runner did not respond. Restart the laptop, or run this script at the laptop itself.'
        exit 1
    }
} elseif (Test-IsAdmin) {
    # Older runner (from before restart requests existed): restart the whole task.
    # This also loads the new runner, so from then on restarts work without administrator rights.
    try {
        & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
    } catch {
        Write-Warning "While stopping: $($_.Exception.Message) - starting the app anyway."
    } finally {
        Start-ScheduledTask -TaskName 'BlevingPlanner'
    }
} elseif ($env:SSH_CONNECTION) {
    Write-Warning 'This one time, the restart has to be done at the laptop itself (or restart the laptop).'
    Write-Warning 'After that, updates and restarts work over SSH too.'
    exit 1
} else {
    if (Restart-Elevated $PSCommandPath $PSBoundParameters) { exit }
}

# Confirm it actually answers before saying so (it can take a few seconds to start).
$port = 3000
$portLine = Select-String -Path (Join-Path $root 'config.env') -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/session" -TimeoutSec 3
        $ok = $true
    } catch { }
}
if ($ok) {
    Write-Host 'The app is running.' -ForegroundColor Green
} else {
    Write-Warning "The app is not answering on port $port. Look in $root\logs\server-error.log"
    exit 1
}
