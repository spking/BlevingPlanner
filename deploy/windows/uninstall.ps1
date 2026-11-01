#Requires -RunAsAdministrator
# Removes the scheduled tasks. Your data (data\), backups and config.env are left alone.
& (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
foreach ($name in @('BlevingPlanner', 'BlevingPlanner backup')) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Host 'Scheduled tasks removed. To stop the public address too, run:  tailscale funnel reset'
