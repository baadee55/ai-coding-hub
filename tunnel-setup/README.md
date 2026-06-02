# tunnel-setup

ここに **cloudflared.exe** を置きます（リポジトリには含めていません。約52MBのバイナリで、各自が公式から取得するのが安全＆軽量なため）。

## 取得方法

[Cloudflare 公式リリース](https://github.com/cloudflare/cloudflared/releases/latest) から
Windows 版 `cloudflared-windows-amd64.exe` をダウンロードし、**このフォルダに `cloudflared.exe` という名前で置く**。

PowerShell でのワンライナー例:
```powershell
Invoke-WebRequest `
  -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" `
  -OutFile "$PSScriptRoot\cloudflared.exe"
```

その後 `setup.ps1` →（`.env` に `CLOUDFLARE_TUNNEL_TOKEN` を設定）→ `start-all.ps1` で起動します。
Cloudflare Tunnel 自体の作り方は[ルート README](../README.md) を参照。
