# Self-heal: if the hub (/health) is down, restart it via start-all.ps1 -NonInteractive.
# Invoked by the scheduled task from install-autoheal.ps1 (at logon + every 5 min).
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot   # parent of scripts\ = project root
$log  = "$root\logs\autoheal.log"
function Log($m) { try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 } catch {} }

# Try several hosts: localhost may resolve to ::1, so checking only 127.0.0.1 can falsely report DOWN (and cause needless restarts)
function Test-HealthPort([int]$port) {
    foreach ($h in @("localhost", "[::1]", "127.0.0.1")) {
        try {
            $r = Invoke-WebRequest -Uri "http://${h}:${port}/health" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch {}
    }
    return $false
}

# Watchdog alone being alive is not enough: if cloudflared or the agent dies,
# the phone sees a dead hub while a watchdog-only check keeps logging "ok".
$down = @()
if (-not (Test-HealthPort 8765)) { $down += "watchdog" }
if (-not (Test-HealthPort 8766)) { $down += "agent" }
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) { $down += "cloudflared" }

if ($down.Count -eq 0) { Log "ok"; exit 0 }

Log "DOWN($($down -join ',')) -> start-all.ps1 -NonInteractive"
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + "$root\start-all.ps1" + '" -NonInteractive'
Start-Process -FilePath "powershell.exe" -ArgumentList $arg -WindowStyle Hidden
Log "restart triggered"
