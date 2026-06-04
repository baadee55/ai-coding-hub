# 📘 手動設定ガイド / Manual configuration

AI エージェントに任せず**自分で設定**したい人向け。基本は `setup.ps1` が雛形を作るので、
あとはこの2ファイルを編集するだけ: **`agent/.env`** と **`agent/config.json`**（どちらも gitignore 済み）。

---

## 1. `agent/.env` — 秘密情報・URL

`agent/.env.example` をコピーして `agent/.env` を作り、値を入れる。

| キー | 必須 | 役割 |
|---|---|---|
| `AGENT_TOKEN` | ✅ | エージェント認証トークン。`setup.ps1` が自動生成。手動なら `python -c "import secrets;print(secrets.token_urlsafe(32))"` |
| `CLOUDFLARE_TUNNEL_TOKEN` | ✅ | Cloudflare Tunnel のトークン（旧名 `CF_TOKEN` も可） |
| `PUBLIC_URL` | ✅ | 公開URL（例 `https://your.example.com`）。`PASSKEY_RP_ID`/CORS はここから自動導出 |
| `PORT` | – | エージェント待受ポート（既定 8766） |
| `PC_NAME` | – | このPCの識別名 |
| `VSCODE_TUNNEL_NAME` / `CURSOR_TUNNEL_NAME` | – | IDEトンネル名（重複しない値に） |
| `PASSKEY_RP_NAME` | – | ログイン時の表示名 |

> ⚠️ **`ANTHROPIC_API_KEY` は絶対に書かない**（API課金で動いてしまう。agent は検出すると起動拒否）。

---

## 2. `agent/config.json` — プロジェクト ＆ エンジン

雛形は `agent/config.example.json`。

### プロジェクト登録（このパス配下でだけ AI が動く安全柵）
```jsonc
"projects": [
  { "id": "myproj", "name": "my-app", "path": "C:\\path\\to\\my-app", "description": "" }
]
```
スマホUIの「＋プロジェクト追加」でも増やせる。

### エンジン設定（任意・Claude Code 以外を使うとき）
```jsonc
"default_engine": "claude_code",          // 既定エンジン。省略時は claude_code
"engines": {
  "gemini":      { "cmd": "gemini", "args": ["-p", "{prompt}"], "prompt_via": "arg",   "strip_env": ["GEMINI_API_KEY"] },
  "codex":       { "cmd": "codex",  "args": ["exec"],            "prompt_via": "stdin", "strip_env": ["OPENAI_API_KEY"] },
  "antigravity": { "cmd": "agy",    "args": ["-p", "{prompt}"], "prompt_via": "arg" }
}
```

| フィールド | 意味 |
|---|---|
| `cmd` | 実行コマンド（PATH 解決。Windows の `.cmd`/`.bat` もOK） |
| `args` | 引数リスト。`{prompt}` / `{cwd}` を置換 |
| `prompt_via` | `stdin`（標準入力に指示文）または `arg`（`{prompt}` 引数に） |
| `strip_env` | サブプロセスから除去する環境変数（そのエンジンのAPIキー課金を回避） |

**エンジンの切替**:
- 全体の既定を変える → `default_engine` を変更
- 都度指定 → `/command` リクエストの `engine` フィールドに名前（例 `"engine":"gemini"`）

> Claude Code は専用アダプタ（リッチ表示・会話継続）。それ以外は `generic_cli` が起動し
> **素テキスト出力**で返す。リッチ表示や resume が要るなら `engines/claude_code.py` を真似て
> 専用アダプタを1枚足す。
>
> ⚠️ 各CLIの起動引数（`cmd`/`args`/`prompt_via`）は**バージョンで変わる**。上記はひな形なので、
> 手元のCLIで `cmd -p "test"` 等を1度叩いて合わせること。

---

## 3. UI を編集したとき（バージョン三点同期）

`ui/` を変えたら **3ファイルを同じ番号に**上げる（古いキャッシュを貫通して更新を届けるため）:
- `ui/index.html` の `APP_VERSION`
- `ui/app.js` の `APP_JS_VERSION`
- `ui/sw.js` の `CACHE_KEY`（`ai-hub-static-vNN`）

緊急脱出: URL に `?nosw=1`（全 Service Worker 削除＋リロード）。

---

## 4. Cloudflare Tunnel

1. Cloudflare Zero Trust → Networks → Tunnels → Create で**トークン**取得 → `.env` の `CLOUDFLARE_TUNNEL_TOKEN`
2. Public hostname を自分のドメインに設定し `http://127.0.0.1:8765` に向ける
3. そのホスト名を `.env` の `PUBLIC_URL` に

`cloudflared.exe` は `tunnel-setup/` に置く（`setup.ps1` が無ければ公式からDL）。

### Cloudflare 以外のトンネル（ngrok / Tailscale Funnel / frp 等）
`127.0.0.1:8765` を公開HTTPSに出せれば何でも使えます。ただし**セキュリティ判定**に注意:

watchdog は「インターネット越し vs PCローカル」を**ヘッダの有無**で判定し、ローカルだけに端末追加などの
特権を与えています。既定は Cloudflare の `cf-connecting-ip`。他トンネルではこのヘッダが無く、
**そのままだとインターネット越しがローカル特権を得る穴**になります。`agent/.env` で対策:

| `.env` | 用途 |
|---|---|
| `REMOTE_MARKER_HEADER=<header>` | そのトンネルが**必ず付ける**ヘッダ名を指定（例 Tailscale Funnel なら `Tailscale-User-Login` 等） |
| `ASSUME_REMOTE=1` | フェイルセーフ。全proxyをリモート扱い＝穴を塞ぐ代わりに、端末追加は PC から `http://127.0.0.1:8765/ui/` で行う |

確信が持てないトンネルでは **`ASSUME_REMOTE=1` が安全**。

---

## 5. 起動・反映

- 起動: `start-all.ps1`（cloudflared / watchdog:8765 / agent:8766 / IDEトンネル）
- `.env` や `agent/*.py` を変えたら **agent を再起動**して反映（`start-all.ps1` 再実行でOK）
- 端末追加(QR)は PC ローカルから `http://127.0.0.1:8765/ui/` を開く

---

## 6. トラブルシュート

### スマホで開くと **502**（ローカルでは動くのに繋がらない）
原因はほぼ **localhost の IPv4/IPv6 解決ずれ**。cloudflared 等が `localhost` を IPv6 `::1` で
叩くのに、watchdog が IPv4 `127.0.0.1` だけで listen していると「ループバックなのに接続拒否」
となりトンネルが 502 を返す。tunnel ログに `dial tcp [::1]:8765 ... refused` が出ていれば確定。

→ **watchdog は IPv4(`127.0.0.1`) と IPv6(`::1`) の両ループバックで listen する**ので、最新版に
更新（`git pull` → `start-all.ps1` 再実行）すれば直る。古い版を使っていて更新できない場合の
回避策は、Cloudflare の Public Hostname の Service を `http://localhost:8765` →
`http://127.0.0.1:8765` に変えること。

困ったら **このリポジトリを AI エージェントに読ませて聞く**のが一番早い（[AGENTS.md](../AGENTS.md) 参照）。
