#Requires -RunAsAdministrator
# Stops the meal planner (the scheduled task and its Node process).
param([switch]$Quiet)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$task = Get-ScheduledTask -TaskName 'BlevingPlanner' -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName 'BlevingPlanner' -ErrorAction SilentlyContinue }
# Stopping the task ends the PowerShell runner, but not necessarily the Node process it started.
$pidFile = Join-Path $root 'logs\server.pid'
if (Test-Path $pidFile) {
    $procId = [int](Get-Content $pidFile -Raw).Trim()
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $procId -Force }
    Remove-Item $pidFile -Force
}
if (-not $Quiet) { Write-Host 'Stopped.' }
