# =========================================================================
# AI Coding Hub - 初回セットアップ（オンボーディング）
#   1) Python venv 作成 + 依存インストール
#   2) AGENT_TOKEN を自動生成
#   3) Cloudflare Tunnel トークン / 公開URL を対話で入力
#   4) agent/.env と agent/config.json を生成
# このスクリプトは何度実行しても安全（既存値は上書き確認する）。
# =========================================================================

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$agentDir = Join-Path $root "agent"
$envFile  = Join-Path $agentDir ".env"
$cfgFile  = Join-Path $agentDir "config.json"
$cfgEx    = Join-Path $agentDir "config.example.json"
$venvPy   = Join-Path $agentDir ".venv\Scripts\python.exe"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " AI Coding Hub セットアップ" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# --- 0) Administrator 拒否（start-all.ps1 と同じ理由） -------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host "ERROR: 管理者権限では実行しないでください（ゾンビ化の原因）。" -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

# --- 0.5) APIキー課金トラップの警告 -------------------------------------
if ($env:ANTHROPIC_API_KEY) {
    Write-Host ""
    Write-Host "⚠️  ANTHROPIC_API_KEY が環境変数に設定されています。" -ForegroundColor Yellow
    Write-Host "   このシステムは Claude の Max/Pro プラン枠で動かす前提です。" -ForegroundColor Yellow
    Write-Host "   キーがあると API 課金で動き高額請求の恐れ → agent は起動を拒否します。" -ForegroundColor Yellow
    Write-Host "   この PC の環境変数から削除してから start-all を実行してください。" -ForegroundColor Yellow
    Write-Host ""
}

# --- 0.7) cloudflared.exe 取得（リポに含めていないので無ければDL） ------
$cfExe = Join-Path $root "tunnel-setup\cloudflared.exe"
if (-not (Test-Path $cfExe)) {
    Write-Host "[*] cloudflared.exe が無いのでダウンロードします..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path (Split-Path $cfExe) | Out-Null
    try {
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cfExe
        Write-Host "  cloudflared.exe を取得しました" -ForegroundColor Green
    } catch {
        Write-Host "  ⚠️ DL失敗。tunnel-setup/README.md を見て手動で配置してください。" -ForegroundColor Yellow
    }
}

# --- 1) Python venv + 依存 ---------------------------------------------
Write-Host "[1/4] Python 仮想環境を準備..." -ForegroundColor Cyan
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Write-Host "ERROR: python が見つかりません。Python 3.10+ を入れてください。" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $venvPy)) {
    & python -m venv (Join-Path $agentDir ".venv")
}
& $venvPy -m pip install --quiet --upgrade pip
& $venvPy -m pip install --quiet -r (Join-Path $agentDir "requirements.txt")
Write-Host "  依存インストール完了" -ForegroundColor Green

# --- 2) AGENT_TOKEN 生成 ------------------------------------------------
$agentToken = & $venvPy -c "import secrets; print(secrets.token_urlsafe(32))"
$agentToken = $agentToken.Trim()

# --- 3) 対話入力 --------------------------------------------------------
Write-Host "[2/4] 公開設定を入力..." -ForegroundColor Cyan
Write-Host "  Cloudflare Tunnel のトークンと公開URLが必要です。" -ForegroundColor Gray
Write-Host "  （未取得なら README の『Cloudflare Tunnel の作り方』を参照。後で .env に直接書いてもOK）" -ForegroundColor Gray
$cfToken = Read-Host "  CLOUDFLARE_TUNNEL_TOKEN (空Enterで後で設定)"
$pubUrl  = Read-Host "  PUBLIC_URL 例 https://your-tunnel.example.com (空Enterで後で設定)"

# --- 4) .env 生成 -------------------------------------------------------
Write-Host "[3/4] agent/.env を生成..." -ForegroundColor Cyan
if (Test-Path $envFile) {
    $ans = Read-Host "  既に .env があります。上書きしますか? (y/N)"
    if ($ans -ne "y") { Write-Host "  .env はそのまま。AGENT_TOKEN 等は手動で確認してください。" -ForegroundColor Yellow }
}
if (-not (Test-Path $envFile) -or $ans -eq "y") {
    $lines = @(
        "# AI Coding Hub .env (setup.ps1 が生成)",
        "# ⚠️ ANTHROPIC_API_KEY は絶対に書かないこと（Max プラン枠死守）",
        "AGENT_TOKEN=$agentToken",
        "CLOUDFLARE_TUNNEL_TOKEN=$cfToken",
        "PUBLIC_URL=$pubUrl",
        "PC_NAME=PC-A",
        "PORT=8766",
        "VSCODE_TUNNEL_NAME=aihub-pc",
        "CURSOR_TUNNEL_NAME=aihub-cursor",
        "PASSKEY_RP_NAME=AI Coding Hub"
    )
    Set-Content -Path $envFile -Value $lines -Encoding UTF8
    Write-Host "  .env 生成完了（AGENT_TOKEN を自動発行）" -ForegroundColor Green
}

# --- 5) config.json 生成 ------------------------------------------------
Write-Host "[4/4] agent/config.json を準備..." -ForegroundColor Cyan
if (-not (Test-Path $cfgFile)) {
    Copy-Item $cfgEx $cfgFile
    Write-Host "  config.example.json をコピー。プロジェクトはスマホUIの『＋追加』か" -ForegroundColor Green
    Write-Host "  config.json を直接編集して登録してください。" -ForegroundColor Green
} else {
    Write-Host "  既存 config.json を保持。" -ForegroundColor Yellow
}

Write-Host "================================================================" -ForegroundColor Green
Write-Host " セットアップ完了。次は start-all.ps1 を実行（またはデスクトップアイコン）。" -ForegroundColor Green
Write-Host " 端末追加(QR)は PC ローカルから http://127.0.0.1:8765/ui/ を開く。" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Read-Host "Press Enter to exit"
