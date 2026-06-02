# 📱 AI Coding Hub — スマホから自宅PCの Claude Code を動かす

> Run **Claude Code** on your home PC, from your phone — **no API bill, no open ports.**
> あなたの Claude **プラン**で動くので**API課金ゼロ**。Cloudflare Tunnel 経由でポート開放も不要。

スマホでアプリを開く → IDE とプロジェクトを選ぶ → 自然言語で指示 → 自宅PCの Claude Code が実行 → 人間語で結果を返す。

> 🔌 既定は **Claude Code** ですが、**Gemini CLI / Codex CLI など他の AI エージェントも設定だけで追加可能**（[エンジン](#-エンジン--claude-code-既定--他のai-cliも設定で追加--bring-your-own)）。中継基盤はエンジン非依存です。

[日本語](#日本語) ・ [English](#english) ・ [⭐ Sponsor / 募金](#-support--募金)

---

## 🚨 最初に必ず読む / READ THIS FIRST

### ⚠️ 1. `ANTHROPIC_API_KEY` を絶対に設定しないこと

このシステムは Claude の **プラン枠**（サブスク）で動かす前提です。
環境変数や `.env` に `ANTHROPIC_API_KEY` があると、Claude Code が **API 従量課金**で動き、
**想定外の高額請求**が来ます（[Issue #37686](https://github.com/anthropics/claude-code/issues/37686): 2日で **$1,800** の事例）。

> **このリポジトリは構造的に防止します**：
> - agent サブプロセスの環境から `ANTHROPIC_API_KEY` を毎回除去
> - **キーが環境にあると agent は起動を拒否**（`main.py` の起動ガード）
>
> それでも、自分の OS の環境変数に残っていないか必ず確認してください。

### ⚠️ 2. これは「スマホから自宅PCで任意コマンドを実行」するツールです

Claude Code は `--permission-mode bypassPermissions` で全ツール許可で動きます。つまり
**スマホを持つ人＝あなたのPCでファイル編集・コマンド実行ができる**ということ。**自己責任**で使ってください。

構造的な安全柵（このリポジトリに実装済み）:
- **登録プロジェクト配下でのみ動作**（`config.json` に登録したパス以外では実行不可）
- **危険コマンドのブロック**・レート制限
- **Passkey(WebAuthn) + JWT 認証**、未認証は厳しいレート制限
- **ポート開放ゼロ**（Cloudflare Tunnel が外→中をつなぐ）

それでも **`AGENT_TOKEN` と Passkey を絶対に漏らさないこと**。漏れると他人があなたのPCを操作できます。

---

## 日本語

### 必要なもの
- Windows 11（PowerShell）。※まず Windows 対応。Mac/Linux は今後
- Python 3.10+
- [Claude Code CLI](https://docs.claude.com/claude-code) にログイン済み（Claude 有料プラン: Pro or Max）
- Cloudflare アカウント（無料）+ 自分のドメイン or `*.cfargotunnel` 系
- VS Code / Cursor（IDEトンネルを使う場合）

### セットアップ（3 ステップ）
```powershell
git clone https://github.com/<you>/ai-coding-hub.git
cd ai-coding-hub
./setup.ps1        # venv作成・依存導入・AGENT_TOKEN自動生成・.env/config.json生成
./start-all.ps1    # cloudflared / watchdog(8765) / agent(8766) / IDEトンネル を起動
```
起動後、**PCローカル**で `http://127.0.0.1:8765/ui/` を開き、QR でスマホ端末を Passkey 登録。
以降はスマホから `PUBLIC_URL` を開くだけ。

### Cloudflare Tunnel の作り方（概要）
1. Cloudflare Zero Trust → Networks → Tunnels → Create で **トークン**を取得 → `.env` の `CLOUDFLARE_TUNNEL_TOKEN`
2. Public hostname を自分のドメインに設定し `http://127.0.0.1:8765` に向ける
3. そのホスト名を `.env` の `PUBLIC_URL` に（`PASSKEY_RP_ID`/CORS は自動導出）

### 設定の要点（全部 `.env`、個人値はコードに焼かない）
| キー | 役割 |
|---|---|
| `AGENT_TOKEN` | エージェント認証（setup が自動生成） |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Tunnel トークン（旧名 `CF_TOKEN` も可） |
| `PUBLIC_URL` | 公開URL。`PASSKEY_RP_ID`/`CORS_ORIGINS` の既定値はここから導出 |
| `config.json` | 登録プロジェクト（**gitignore済**。`config.example.json` が雛形） |

---

## English

**AI Coding Hub** lets you operate **Claude Code on your home PC from your phone**, running on
your **own Claude plan** (no API billing) over a **Cloudflare Tunnel** (no port forwarding).

> ⚠️ **Never set `ANTHROPIC_API_KEY`** — it switches Claude Code to metered API billing
> (a user reported **$1,800 in 2 days**). The agent **refuses to start** if the key is present.
>
> ⚠️ This is a **remote command runner**: whoever holds the phone token can run commands on your PC.
> Use at your own risk. Guardrails: registered-paths-only, dangerous-command block, Passkey+JWT auth,
> rate limiting, zero open ports. **Keep `AGENT_TOKEN` and your passkey secret.**

```powershell
git clone https://github.com/<you>/ai-coding-hub.git
cd ai-coding-hub
./setup.ps1      # venv + deps + auto-generate AGENT_TOKEN + write .env/config.json
./start-all.ps1  # cloudflared / watchdog / agent / IDE tunnels
```
Open `http://127.0.0.1:8765/ui/` **locally** to register your phone via Passkey (QR), then use it from anywhere.

---

## 🔌 エンジン — Claude Code 既定 ＋ 他のAI CLIも設定で追加 / Bring your own

中継・UI・認証・トンネルは **エンジン非依存**。実際にコードを書くエンジンは差し替え可能です。

- **Claude Code**（既定）… 専用アダプタでツール呼び出しの構造化表示・会話継続(resume)に対応。
- **その他の CLI**（Gemini CLI / Codex CLI など）… **コードを書かず `agent/config.json` の設定だけ**で追加できます（`generic_cli` が起動して出力を素テキストで返す“二級”対応）。

```jsonc
// agent/config.json （雛形は config.example.json）
"default_engine": "claude_code",
"engines": {
  "gemini":      { "cmd": "gemini", "args": ["-p", "{prompt}"], "prompt_via": "arg",   "strip_env": ["GEMINI_API_KEY"] },
  "codex":       { "cmd": "codex",  "args": ["exec"],            "prompt_via": "stdin", "strip_env": ["OPENAI_API_KEY"] },
  "antigravity": { "cmd": "agy",    "args": ["-p", "{prompt}"], "prompt_via": "arg" }   // Google Antigravity CLI
}
```
`{prompt}`/`{cwd}` を置換、`prompt_via` で標準入力/引数を選択、`strip_env` でそのエンジンの
**APIキー課金を回避**（＝Claude と同じ“サブスクで動かす・API課金ゼロ”の思想を各エンジンで踏襲）。
**ヘッドレス実行できる AI コーディング CLI** なら載ります:
- **Claude Code**（既定・専用アダプタ） / **Gemini CLI**（`gemini -p`） / **OpenAI Codex CLI**（`codex exec`） /
  **Google Antigravity CLI**（`agy -p`、アカウント認証＝APIキー不要）
- それぞれ**自分のサブスク枠**で動く（API課金ゼロ）

> ⚠️ Claude Code 以外の設定は**ひな形**です。各 CLI の正確な起動引数はバージョンで変わるので、
> 導入時に手元の CLI で1度確認してください（リッチ表示・resume が要るなら専用アダプタを1枚足す）。
> ※ IDE（Antigravity アプリ等）は別軸＝IDEトンネルで“ブラウザで開く”用途。エンジンは**ヘッドレスCLI**のみ。

## 🤖 自分の AI エージェントでカスタムするのが正解

このリポジトリは **「あなたのお使いの AI コーディングエージェント（Claude Code 等）に読み込ませて、
自分用に改造して使う」** ことを前提に作っています。個人設定は **すべて `agent/.env` と
`agent/config.json` に集約**、コードには個人ドメイン・パス・トークンを焼いていません。

おすすめの使い方:
1. フォークを clone して、**あなたの AI エージェントにこのリポジトリ＋[CLAUDE.md](CLAUDE.md) を読ませる**
2. 「自分用に設定して」「Gemini CLI を使えるように engines に追加して」「UIをこう変えて」と頼む
3. エージェントが CLAUDE.md の固定事項を踏まえて `.env`/`config.json`/コードを編集

→ 公式の“全部入りUI”を待つより、**各自が自分のエージェントで好きに拡張**するのが速くて自由。
詳細は [CLAUDE.md](CLAUDE.md) の「フォーク時に変える場所」を参照。

---

## 💜 Support / 寄付 <a id="support"></a>

OSS（MIT）です。各自が自分の Claude アカ・自分のPCで動かすため、こちらに継続コストは発生しません。
気に入ったら応援してもらえると、メンテと Mac/Linux 対応の励みになります 🙏

**2 つの方法 / Two ways to support:**

### 1. GitHub Sponsors（fiat / カード）
[![Sponsor](https://img.shields.io/badge/Sponsor-baadee55-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/baadee55)
→ https://github.com/sponsors/baadee55

### 2. Crypto（口座不要・世界中どこからでも / no account needed）
送金が一番ラクなのは **USDT (TRC20)**。

| Coin / Network | Address |
|---|---|
| **ETH / ERC-20 / USDT-ERC20** | `0xD9397E6d6e2b45eaf38182fbE93213bf63A97b50` |
| **USDT — TRON (TRC20)** | `TL2QgdD9684N7bjfYFT9e5Mc6PBwoXAbC9` |
| **BTC** | `33SU1T3Dip6btiLS8FnDMoDu8xFYvUuuHz` |

> ⚠️ 必ず**ネットワークを一致**させて送ってください（TRC20宛にERC20で送る等は紛失します）。
> Please match the network exactly when sending.

## License
[MIT](LICENSE)。`ANTHROPIC_API_KEY` 課金・任意コマンド実行のリスクは利用者の自己責任です。
