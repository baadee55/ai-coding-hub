# AI Coding Hub - Boot script
# Refuses admin elevation, kills zombies (via UAC if needed), tracks PIDs

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8

# 自分の場所を基準に動く（どこに clone しても OK。固定パスを焼かない）
$root      = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$python    = "$root\agent\.venv\Scripts\python.exe"
$cfExe     = "$root\tunnel-setup\cloudflared.exe"
$vscodeBin = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
$cursorBin = "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
$logDir    = "$root\logs"
$pidDir    = "$logDir\pids"

# [0] Refuse admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Red
    Write-Host " ERROR: Do NOT run this script as Administrator." -ForegroundColor Red
    Write-Host "================================================================" -ForegroundColor Red
    Write-Host " Admin-launched processes become zombies and block restart."
    Write-Host " Fix: right-click 'AI Coding Hub' shortcut -> Properties ->"
    Write-Host "      Shortcut -> Advanced -> uncheck 'Run as administrator'."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $pidDir -Force | Out-Null

# Helpers
# 管理者権限が要る kill は「その場で UAC」を出さず、いったん貯めておき、
# 全プロセス分まとめて一度だけ昇格 taskkill する（Flush-ElevatedKills）。
# こうしないとゾンビが watchdog/agent/cloudflared と複数あるとき、起動毎に
# UAC が個数ぶん（=3回）出てしまう。[[project_agent_runs_as_system]] のゾンビ対策。
$script:PendingElevatedKills = @()

function Kill-Pid {
    param([int]$ProcId, [string]$Label)
    if (-not $ProcId -or $ProcId -le 0) { return $true }
    try { Get-Process -Id $ProcId -ErrorAction Stop | Out-Null } catch { return $true }
    try {
        Stop-Process -Id $ProcId -Force -ErrorAction Stop
        Write-Host "  [killed] $Label (PID $ProcId)" -ForegroundColor DarkGray
        return $true
    } catch {
        # 通常権限で倒せない → 昇格キューに積むだけ。UAC はまだ出さない。
        Write-Host "  [defer]  $Label (PID $ProcId) - needs admin, queued" -ForegroundColor Yellow
        $script:PendingElevatedKills += $ProcId
        return $true
    }
}

# 貯めた昇格 kill を一度の UAC でまとめて実行する。
function Flush-ElevatedKills {
    $pids = $script:PendingElevatedKills | Where-Object { $_ -gt 0 } | Select-Object -Unique
    $script:PendingElevatedKills = @()
    if (-not $pids -or $pids.Count -eq 0) { return $true }
    Write-Host "  [admin]  Elevating once to kill $($pids.Count) leftover process(es) via UAC..." -ForegroundColor Yellow
    $killArgs = ($pids | ForEach-Object { "/PID $_" }) -join " "
    Start-Process "cmd.exe" -ArgumentList "/c taskkill /F $killArgs" -Verb RunAs -Wait -ErrorAction SilentlyContinue
    Start-Sleep 1
    $survivors = $pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    if ($survivors) {
        Write-Host "  [FAIL]   Could not kill: $($survivors -join ', ')" -ForegroundColor Red
        return $false
    }
    Write-Host "  [killed] leftover process(es) [via UAC]" -ForegroundColor DarkGray
    return $true
}

function Kill-Port {
    param([int]$Port, [string]$Label)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $true }
    return Kill-Pid -ProcId $conn.OwningProcess -Label "$Label :$Port"
}

function Start-Tracked {
    param([string]$Name, [string]$Exe, [Parameter()][string]$ArgList = "", [string]$Cwd, [string]$LogName)
    $pidFile = "$pidDir\$Name.pid"
    if (Test-Path $pidFile) {
        $old = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($old) { Kill-Pid -ProcId ([int]$old) -Label $Name | Out-Null }
    }
    $proc = Start-Process -FilePath $Exe -ArgumentList $ArgList -WorkingDirectory $Cwd -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir\$LogName.log" -RedirectStandardError "$logDir\$LogName.err" -PassThru
    Set-Content -Path $pidFile -Value $proc.Id
    Write-Host "  [start]  $Name (PID $($proc.Id))" -ForegroundColor Green
    return $proc
}

# [1] Read .env
$envFile = "$root\agent\.env"
$cfTok = ""; $tunnelName = "aihub-pc"; $cursorTunnelName = "aihub-cursor"; $pubUrl = ""
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        # トークンは新名 CLOUDFLARE_TUNNEL_TOKEN を優先、旧名 CF_TOKEN も後方互換で読む
        if ($_ -match "^CLOUDFLARE_TUNNEL_TOKEN=(.+)$") { $cfTok = $Matches[1].Trim() }
        if ($_ -match "^CF_TOKEN=(.+)$" -and -not $cfTok) { $cfTok = $Matches[1].Trim() }
        if ($_ -match "^VSCODE_TUNNEL_NAME=(.+)$")   { $tunnelName = $Matches[1].Trim() }
        if ($_ -match "^CURSOR_TUNNEL_NAME=(.+)$")   { $cursorTunnelName = $Matches[1].Trim() }
        if ($_ -match "^PUBLIC_URL=(.+)$")           { $pubUrl = $Matches[1].Trim() }
    }
}
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: agent\.env がありません。先に setup.ps1 を実行してください。" -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
if (-not $cfTok) { Write-Host "ERROR: CLOUDFLARE_TUNNEL_TOKEN が agent\.env にありません" -ForegroundColor Red; exit 1 }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " AI Coding Hub starting..." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# [2] Kill existing
Write-Host "[1/4] Stopping existing processes..." -ForegroundColor Cyan
$portOk = $true
foreach ($pair in @(@(8765, "watchdog"), @(8766, "agent"))) {
    $portOk = (Kill-Port -Port $pair[0] -Label $pair[1]) -and $portOk
}
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Kill-Pid -ProcId $_.Id -Label "cloudflared" | Out-Null
}
foreach ($name in @("watchdog","agent","vscode-tunnel","cursor-tunnel","cloudflared")) {
    $pidFile = "$pidDir\$name.pid"
    if (Test-Path $pidFile) {
        $old = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($old) { Kill-Pid -ProcId ([int]$old) -Label $name | Out-Null }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}
# 通常権限で倒せなかった分を、ここで一度だけ UAC を出してまとめて kill。
$portOk = (Flush-ElevatedKills) -and $portOk
if (-not $portOk) {
    Write-Host ""
    Write-Host "ERROR: Could not free required ports." -ForegroundColor Red
    Write-Host "  Kill remaining PIDs as Administrator, or reboot the PC." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}
Start-Sleep 2

# [3] Start
Write-Host "[2/4] Starting agent stack..." -ForegroundColor Cyan
Start-Tracked -Name "cloudflared"    -Exe $cfExe   -ArgList "tunnel run --token $cfTok"          -Cwd $root         -LogName "tunnel"
Start-Tracked -Name "watchdog"       -Exe $python  -ArgList "-u watchdog.py"                     -Cwd "$root\agent" -LogName "watchdog"
Start-Sleep 1
Start-Tracked -Name "agent"          -Exe $python  -ArgList "-u main.py"                         -Cwd "$root\agent" -LogName "agent"

Write-Host "[3/4] Starting IDE tunnels..." -ForegroundColor Cyan
if (Test-Path $vscodeBin) {
    Start-Tracked -Name "vscode-tunnel" -Exe "cmd.exe" -ArgList "/c `"$vscodeBin`" tunnel --accept-server-license-terms --name $tunnelName" -Cwd $root -LogName "vscode-tunnel"
    Write-Host "  VS Code: https://vscode.dev/tunnel/$tunnelName" -ForegroundColor Cyan
}
if (Test-Path $cursorBin) {
    Start-Tracked -Name "cursor-tunnel" -Exe "cmd.exe" -ArgList "/c `"$cursorBin`" tunnel --accept-server-license-terms --name $cursorTunnelName" -Cwd $root -LogName "cursor-tunnel"
    Write-Host "  Cursor:  https://cursor.com/tunnel/$cursorTunnelName" -ForegroundColor Magenta
}

# [4] Health check
Write-Host "[4/4] Verifying health..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep 1
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if ($ok) {
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host " [OK] AI Coding Hub started" -ForegroundColor Green
    Write-Host "   Local:  http://127.0.0.1:8765/ui/" -ForegroundColor Green
    if ($pubUrl) { Write-Host "   Public: $($pubUrl.TrimEnd('/'))/ui/" -ForegroundColor Green }
    Write-Host "================================================================" -ForegroundColor Green
} else {
    Write-Host "WARNING: health check failed. See logs\ for details." -ForegroundColor Yellow
}
