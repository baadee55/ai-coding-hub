# Non-admin auto-recovery. Creates a shortcut in the user's Startup folder that
# launches autoheal-loop.ps1 hidden at logon (auto-start + self-heal every 5 min).
# No administrator rights required. Run this once.
# Remove with: Remove-Item "$([Environment]::GetFolderPath('Startup'))\AIHub-Autoheal.lnk"
$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $PSScriptRoot
$loop  = "$root\scripts\autoheal-loop.ps1"
if (-not (Test-Path $loop)) { Write-Host "ERROR: $loop not found" -ForegroundColor Red; exit 1 }

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AIHub-Autoheal.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $loop + '"'
$sc.WorkingDirectory = $root
$sc.WindowStyle      = 7   # minimized/hidden
$sc.Description       = "AI Coding Hub auto-start + self-heal (non-admin)"
$sc.Save()

Write-Host "[OK] Startup shortcut created (no admin needed):" -ForegroundColor Green
Write-Host "     $lnkPath" -ForegroundColor Green
Write-Host "     - Runs at logon: starts the hub if down, then self-heals every 5 min." -ForegroundColor Green
Write-Host "     Remove: Remove-Item '$lnkPath'" -ForegroundColor DarkGray
