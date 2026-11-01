#Requires -RunAsAdministrator
# Pulls the latest version from GitHub and restarts the app. Your data and config.env are not touched.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed - nothing was restarted.' }
& (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
Start-ScheduledTask -TaskName 'BlevingPlanner'
Write-Host 'Updated and restarted.' -ForegroundColor Green
