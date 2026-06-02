# 📱 AI Coding Hub — スマホから自宅PCの Claude Code を動かす

> Run **Claude Code** on your home PC, from your phone — **no API bill, no open ports.**
> あなたの Claude **Max/Pro プラン枠**で動くので追加課金ゼロ。Cloudflare Tunnel 経由でポート開放も不要。

スマホでアプリを開く → IDE とプロジェクトを選ぶ → 自然言語で指示 → 自宅PCの Claude Code が実行 → 人間語で結果を返す。

[日本語](#日本語) ・ [English](#english) ・ [⭐ Sponsor / 募金](#-support--募金)

---

## 🚨 最初に必ず読む / READ THIS FIRST

### ⚠️ 1. `ANTHROPIC_API_KEY` を絶対に設定しないこと

このシステムは Claude の **Max/Pro プラン枠**で動かす前提です。
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
- [Claude Code CLI](https://docs.claude.com/claude-code) にログイン済み（Max/Pro プラン）
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
your **Claude Max/Pro plan** (no API billing) over a **Cloudflare Tunnel** (no port forwarding).

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

## 🛠 フォーク/改造（AIコーディング向け）

このリポジトリは **自分の Claude にフォークを編集させて使う**ことを想定しています。
改造時に触る個人設定は **すべて `agent/.env` と `agent/config.json` に集約**されており、
コードには個人ドメイン・パス・トークンを焼いていません。詳しくは [CLAUDE.md](CLAUDE.md) の
「フォーク時に変える場所」を参照。Claude Code に「このプロジェクトを自分用に設定して」と言えば、
CLAUDE.md を読んで `.env` の雛形を埋めてくれます。

---

## ⭐ Support / 募金

OSS です。各自が自分の Claude アカ・自分のPCで動かすため、こちらに継続コストは発生しません。
気に入ったら **GitHub Sponsors**（[Sponsor]ボタン）や Ko-fi で応援してもらえると嬉しいです。
設定は [.github/FUNDING.yml](.github/FUNDING.yml)。

## License
MIT（予定）。`ANTHROPIC_API_KEY` 課金・任意コマンド実行のリスクは利用者の自己責任です。
