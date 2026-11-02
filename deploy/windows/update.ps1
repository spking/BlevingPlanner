# Pulls the latest version from GitHub and restarts the app. Your data and config.env are not touched.
# Needs no administrator rights, so it also works over SSH.
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed - nothing was changed or restarted.' }

& (Join-Path $PSScriptRoot 'restart.ps1')
