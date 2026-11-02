# Keeps the meal planner running: starts Node, and restarts it if it ever stops.
# Started at boot by the "BlevingPlanner" scheduled task (see install.ps1). Not meant to be run by hand.
#
# It also restarts Node when the file "restart.request" appears in the project folder. That lets
# restart.ps1 / update.ps1 restart the app WITHOUT administrator rights (e.g. over SSH, where Windows
# gives administrator accounts limited rights): this runner runs as SYSTEM and does the privileged part.
param([Parameter(Mandatory = $true)][string]$Node)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$pidFile = Join-Path $logs 'server.pid'
$outLog = Join-Path $logs 'server.log'
$errLog = Join-Path $logs 'server-error.log'
$requestFile = Join-Path $root 'restart.request'

# Tells restart.ps1 that this runner understands restart requests.
Set-Content -Path (Join-Path $logs 'runner.version') -Value '2'
# A request left over from before a reboot is already satisfied by this fresh start.
Remove-Item $requestFile -Force -ErrorAction SilentlyContinue

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

    # Wait for Node to exit by itself, or for a restart request.
    $requested = $false
    while (-not $p.HasExited) {
        if (Test-Path $requestFile) {
            $requested = $true
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            $p.WaitForExit()
            # Removed only after Node has stopped, so restart.ps1 can tell the restart has begun.
            Remove-Item $requestFile -Force -ErrorAction SilentlyContinue
            break
        }
        Start-Sleep -Seconds 2
    }

    if ($requested) {
        Add-Content -Path $errLog -Value ("[{0}] Restart requested; starting again" -f (Get-Date -Format s))
        Start-Sleep -Seconds 1
    } else {
        Add-Content -Path $errLog -Value ("[{0}] Node exited with code {1}; restarting in 5 seconds" -f (Get-Date -Format s), $p.ExitCode)
        Start-Sleep -Seconds 5
    }
}
