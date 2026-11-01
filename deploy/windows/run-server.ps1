# Keeps the meal planner running: starts Node, and restarts it if it ever stops.
# Started at boot by the "BlevingPlanner" scheduled task (see install.ps1). Not meant to be run by hand.
param([Parameter(Mandatory = $true)][string]$Node)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$pidFile = Join-Path $logs 'server.pid'
$outLog = Join-Path $logs 'server.log'
$errLog = Join-Path $logs 'server-error.log'

while ($true) {
    # Keep the previous run's logs so a crash can be investigated.
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) { Move-Item -Force $f "$f.previous" }
    }
    $p = Start-Process -FilePath $Node `
        -ArgumentList '--disable-warning=ExperimentalWarning', '--env-file-if-exists=config.env', 'server.js' `
        -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $null = $p.Handle  # keeps the handle so ExitCode is available afterwards
    Set-Content -Path $pidFile -Value $p.Id
    $p.WaitForExit()
    Add-Content -Path $errLog -Value ("[{0}] Node exited with code {1}; restarting in 5 seconds" -f (Get-Date -Format s), $p.ExitCode)
    Start-Sleep -Seconds 5
}
