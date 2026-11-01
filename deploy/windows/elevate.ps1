# Shared helper: if the calling script is not running as administrator, re-launch it in a new
# administrator window (Windows shows its "Do you want to allow..." prompt) with the same options.
# Usage at the top of a script, right after its param() block:
#   . (Join-Path $PSScriptRoot 'elevate.ps1')
#   if (Restart-Elevated $PSCommandPath $PSBoundParameters) { exit }

function Test-IsAdmin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-Elevated {
    param([string]$ScriptPath, [System.Collections.IDictionary]$BoundParameters)
    if (Test-IsAdmin) { return $false }

    # -NoExit keeps the new window open so you can read the result.
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$ScriptPath`"")
    foreach ($key in $BoundParameters.Keys) {
        $value = $BoundParameters[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $argList += "-$key" }
        } else {
            $argList += "-$key"
            $argList += "`"$value`""
        }
    }
    Write-Host 'This needs administrator rights. Windows will ask for permission - click Yes.' -ForegroundColor Yellow
    Write-Host 'The rest happens in the new window that opens.'
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -ErrorAction Stop | Out-Null
    } catch {
        Write-Warning 'Administrator permission was not given, so nothing was changed.'
    }
    return $true
}
