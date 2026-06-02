Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "Created .env - please set your API keys" -ForegroundColor Yellow
        notepad .env
        Read-Host "Press Enter to continue after editing .env"
    }
}

if (-not (Test-Path ".venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
}

Write-Host "Installing packages..." -ForegroundColor Cyan
.\.venv\Scripts\pip.exe install -q -r requirements.txt

Write-Host ""
Write-Host "=== AI Coding Hub Agent ===" -ForegroundColor Green
Write-Host "URL: http://localhost:8765"
Write-Host "UI:  http://localhost:8765/ui/"
Write-Host "API: http://localhost:8765/docs"
Write-Host ""

.\.venv\Scripts\python.exe main.py
