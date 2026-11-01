#Requires -RunAsAdministrator
<#
  Sets the meal planner up to run on this PC permanently:
    - "BlevingPlanner"         starts the app at boot (no login needed) and restarts it if it crashes
    - "BlevingPlanner backup"  makes a backup of the database every night
  Safe to run again (it replaces the tasks).

  Usage (in PowerShell opened with "Run as administrator", from the project folder):
    powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
  Options:
    -BackupTime 03:30     when the nightly backup runs
    -KeepAwake            also stop the laptop sleeping/hibernating on mains power and when the lid is closed
#>
param(
    [string]$BackupTime = '03:30',
    [switch]$KeepAwake
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# --- Checks -------------------------------------------------------------
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw 'Node.js was not found. Install the LTS version from https://nodejs.org, then open a NEW administrator PowerShell window and run this again.'
}
$node = $nodeCmd.Source
$version = [version]((& $node --version).Trim().TrimStart('v'))
if ($version -lt [version]'22.13.0') { throw "Node.js $version is too old. Install 22.13 or newer from https://nodejs.org." }

$config = Join-Path $root 'config.env'
if (-not (Test-Path $config)) {
    throw "config.env is missing. Run:  copy config.example.env config.env  then edit it (password and PUBLIC_URL)."
}
$configText = Get-Content $config -Raw
if ($configText -match 'APP_PASSWORD=change-me') { throw 'Set your own APP_PASSWORD in config.env first.' }
if ($configText -match 'your-laptop\.your-tailnet') { Write-Warning 'PUBLIC_URL in config.env is still the example value - the calendar link will be wrong until you set it.' }

# --- App task (runs as SYSTEM at boot, so nobody needs to be logged in) ---
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $root 'deploy\windows\run-server.ps1'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

& (Join-Path $PSScriptRoot 'stop.ps1') -Quiet

$appTask = Register-ScheduledTask -TaskName 'BlevingPlanner' -Force -Principal $principal `
    -Description 'Meal planner web app (BlevingPlanner)' `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Action (New-ScheduledTaskAction -Execute $powershell -WorkingDirectory $root `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Node `"$node`"") `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew)
# ExecutionTimeLimit 0 = run forever (the Windows default would stop it after 3 days).

# --- Nightly backup task ---------------------------------------------------
$backupTask = Register-ScheduledTask -TaskName 'BlevingPlanner backup' -Force -Principal $principal `
    -Description 'Nightly backup of the meal planner database' `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $BackupTime) `
    -Action (New-ScheduledTaskAction -Execute $node -WorkingDirectory $root `
        -Argument '--disable-warning=ExperimentalWarning --env-file-if-exists=config.env scripts\backup.js') `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10))

# --- Optional: keep the laptop awake on mains power --------------------------
if ($KeepAwake) {
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    # Closing the lid on mains power: do nothing (0)
    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
    powercfg /setactive SCHEME_CURRENT
    Write-Host 'Power: no sleep/hibernate on mains power, closing the lid does nothing.'
}

Start-ScheduledTask -TaskName 'BlevingPlanner'
Start-Sleep -Seconds 4

# --- Check it answers ------------------------------------------------------
$port = 3000
$portLine = Select-String -Path $config -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/session" -TimeoutSec 10
    Write-Host "OK - the app is running on http://127.0.0.1:$port (status $($r.StatusCode))." -ForegroundColor Green
    Write-Host "Next: expose it with   tailscale funnel --bg $port"
} catch {
    Write-Warning "The app did not answer on port $port. Look in $root\logs\server-error.log"
}
