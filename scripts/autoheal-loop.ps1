# Non-admin self-heal loop. Launched at logon via the Startup-folder shortcut
# created by install-autostart.ps1. Runs in the user session (no admin needed).
# First iteration starts the hub if it is down (= auto-start at logon),
# then re-checks /health every 5 minutes and restarts if it ever goes down.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
while ($true) {
    try { & "$root\scripts\autoheal.ps1" } catch {}
    Start-Sleep -Seconds 300
}
