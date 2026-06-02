# =========================================================================
# AI Coding Hub - doctor (self-check)
#   Verifies your setup in one shot to pinpoint "it doesn't work" causes.
#   Read-only. No changes are made.
# =========================================================================
$ErrorActionPreference = "Continue"
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$agentDir = Join-Path $root "agent"
$envFile  = Join-Path $agentDir ".env"
$cfgFile  = Join-Path $agentDir "config.json"
$venvPy   = Join-Path $agentDir ".venv\Scripts\python.exe"
$cfExe    = Join-Path $root "tunnel-setup\cloudflared.exe"

$fails = 0; $warns = 0
function Pass($m){ Write-Host "  [PASS] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:warns++ }
function Fail($m){ Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:fails++ }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " AI Coding Hub doctor" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# --- Billing trap (most important) -------------------------------------
Write-Host "[1] Billing trap (ANTHROPIC_API_KEY)" -ForegroundColor Cyan
if ($env:ANTHROPIC_API_KEY) {
    Fail "ANTHROPIC_API_KEY is set in env -> agent refuses to start. Remove it."
} else {
    Pass "No ANTHROPIC_API_KEY in env"
}
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern "^\s*ANTHROPIC_API_KEY\s*=" -Quiet)) {
    Fail "agent/.env contains an ANTHROPIC_API_KEY line -> remove it."
} else {
    Pass "No ANTHROPIC_API_KEY line in .env"
}

# --- Python / venv -----------------------------------------------------
Write-Host "[2] Python / venv" -ForegroundColor Cyan
if (Get-Command python -ErrorAction SilentlyContinue) { Pass "python found" } else { Fail "python not on PATH (install 3.10+)" }
if (Test-Path $venvPy) { Pass "venv present" } else { Warn "venv missing -> run setup.ps1" }

# --- Engine CLIs -------------------------------------------------------
Write-Host "[3] Engine CLIs" -ForegroundColor Cyan
$claude = (Get-Command claude -ErrorAction SilentlyContinue)
if ($claude) { Pass "claude found ($($claude.Source))" } else { Fail "claude not on PATH (Claude Code CLI not installed / not logged in)" }
if (Test-Path $cfgFile) {
    try {
        $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.engines) {
            foreach ($p in $cfg.engines.PSObject.Properties) {
                $cmd = $p.Value.cmd
                if ($cmd) {
                    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
                        Pass "engine '$($p.Name)' cmd '$cmd' found"
                    } else {
                        Warn "engine '$($p.Name)' cmd '$cmd' not on PATH (install it to use that engine)"
                    }
                }
            }
        }
    } catch {
        Warn "could not parse engines in config.json: $_"
    }
}

# --- .env --------------------------------------------------------------
Write-Host "[4] agent/.env" -ForegroundColor Cyan
if (Test-Path $envFile) {
    Pass ".env present"
    $envTxt = Get-Content $envFile
    if (($envTxt | Where-Object { $_ -match "^\s*AGENT_TOKEN\s*=\s*\S" }).Count -gt 0) { Pass "AGENT_TOKEN set" } else { Fail "AGENT_TOKEN not set" }
    $hasTunnelTok = (($envTxt | Where-Object { $_ -match "^\s*CLOUDFLARE_TUNNEL_TOKEN\s*=\s*\S" }).Count -gt 0) -or (($envTxt | Where-Object { $_ -match "^\s*CF_TOKEN\s*=\s*\S" }).Count -gt 0)
    if ($hasTunnelTok) { Pass "tunnel token set" } else { Warn "CLOUDFLARE_TUNNEL_TOKEN not set (ok if not exposing publicly)" }
    if (($envTxt | Where-Object { $_ -match "^\s*PUBLIC_URL\s*=\s*\S" }).Count -gt 0) { Pass "PUBLIC_URL set" } else { Warn "PUBLIC_URL not set (source of Passkey RP / CORS)" }
} else {
    Fail ".env missing -> run setup.ps1"
}

# --- config.json -------------------------------------------------------
Write-Host "[5] agent/config.json" -ForegroundColor Cyan
if (Test-Path $cfgFile) {
    try {
        $cfg2 = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $n = @($cfg2.projects).Count
        if ($n -gt 0) { Pass "$n registered project(s)" } else { Warn "no projects registered (UI '+ add' or edit config.json)" }
    } catch {
        Fail "config.json is invalid JSON: $_"
    }
} else {
    Warn "config.json missing (fine on first run; setup.ps1 creates it)"
}

# --- binaries / running state ------------------------------------------
Write-Host "[6] binaries / running state" -ForegroundColor Cyan
if (Test-Path $cfExe) { Pass "cloudflared.exe present" } else { Warn "cloudflared.exe missing (tunnel-setup/README.md or setup.ps1 downloads it)" }
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { Pass "watchdog(8765) responding (running)" } else { Warn "watchdog responded with non-200" }
} catch {
    Warn "watchdog(8765) not responding (maybe not started -> start-all.ps1)"
}

# --- summary -----------------------------------------------------------
Write-Host "================================================================" -ForegroundColor Cyan
if ($fails -eq 0 -and $warns -eq 0) {
    Write-Host " Result: ALL PASS" -ForegroundColor Green
} elseif ($fails -eq 0) {
    Write-Host " Result: FAIL 0 / WARN $warns (no blockers)" -ForegroundColor Yellow
} else {
    Write-Host " Result: FAIL $fails / WARN $warns (fix the red items)" -ForegroundColor Red
}
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " Tip: feed this repo to your AI agent and ask it to 'fix the doctor results'." -ForegroundColor Gray
