# Stops the meal planner (the scheduled task and its Node process).
param([switch]$Quiet)

. (Join-Path $PSScriptRoot 'elevate.ps1')
if (Restart-Elevated $PSCommandPath $PSBoundParameters) { exit }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$task = Get-ScheduledTask -TaskName 'BlevingPlanner' -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName 'BlevingPlanner' -ErrorAction SilentlyContinue }

# Windows normally ends the Node process together with the task, so by now it may already be gone
# (or be in the middle of exiting). Make sure it is gone, without treating "already gone" as an error.
$pidFile = Join-Path $root 'logs\server.pid'
if (Test-Path $pidFile) {
    $procId = 0
    [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$procId)
    if ($procId -gt 0) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $procId -Timeout 15 -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
if (-not $Quiet) { Write-Host 'Stopped.' }
