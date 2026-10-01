# Register the self-heal scheduled task (runs autoheal.ps1 at logon + every 5 min).
# No admin required; runs as the current user. Run this once.
# Remove with: Unregister-ScheduledTask -TaskName 'AIHub-Autoheal' -Confirm:$false
$ErrorActionPreference = "Stop"
$root     = Split-Path -Parent $PSScriptRoot
$autoheal = "$root\scripts\autoheal.ps1"
$taskName = "AIHub-Autoheal"

if (-not (Test-Path $autoheal)) { Write-Host "ERROR: $autoheal not found" -ForegroundColor Red; exit 1 }

$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $autoheal + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg

# At logon (doubles as auto-start on boot) + then every 5 minutes (effectively indefinite)
$trigLogon  = New-ScheduledTaskTrigger -AtLogOn
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# Not admin (this project forbids admin execution to avoid zombie processes)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigLogon, $trigRepeat) -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "[OK] Scheduled task '$taskName' registered." -ForegroundColor Green
Write-Host "     - Auto-start at logon + checks /health every 5 min, auto-restarts if down" -ForegroundColor Green
Write-Host "     - Runs as user $env:USERNAME (not admin)" -ForegroundColor Green
Write-Host "     Remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor DarkGray
