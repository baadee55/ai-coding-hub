# PC作業のAI

スマホから PC 作業を AI に任せるシステム。

## やりたいフロー

```
スマホでアプリを開く
  ↓ IDE を選ぶ（Cursor / VS Code）
  ↓ プロジェクト一覧から選ぶ
  ↓ 自然言語で指示
  ↓ PC側の Claude Code（Claude 有料プラン枠: Pro/Max）が実行
  ↓ 結果を人間語で返す
```

## 構成

```
スマホ
    ↓ HTTPS
https://<your-tunnel-domain>（Cloudflare Tunnel、固定URL。.env の PUBLIC_URL）
    ↓
watchdog（127.0.0.1:8765）  ← agent/watchdog.py
    ・公開口。/start /restart と、それ以外を agent へ proxy
    ・agent が落ちてたら 503 + 再起動ボタン誘導
    ↓ Passkey / JWT / AGENT_TOKEN 認証
FastAPI 中継AI（127.0.0.1:8766）  ← agent/main.py
    ↓ サブプロセス起動
Claude Code CLI（Claude 有料プラン枠: Pro/Max、追加課金なし、既定 Opus 4.8）
    ↓ tool 呼び出し
PC のファイル・ターミナル
```

⚠️ **重要：`ANTHROPIC_API_KEY` を環境変数や .env に絶対に設定しないこと。**
設定されていると Claude Code が Max プランではなく API 課金で動き、想定外の請求が来る（Issue #37686 で 2 日で $1,800 の事例あり）。

### 設計のキモ（なぜこの形？）

- **ポート開放ゼロ** … Cloudflare Tunnel が外→中をつなぐので、ルーター設定なしで安全に公開。
- **watchdog を挟む** … agent が落ちてもスマホから再起動でき、止まらない。
- **Max プラン枠で実行** … API キーをサブプロセスから消すことで、想定外の課金を構造的に防止。
- **登録プロジェクト配下のみ** … 任意の場所でコマンドを走らせない安全柵。

## 実装済み

- スマホUI（PWA）: `<PUBLIC_URL>/ui/`（自分の Cloudflare Tunnel ドメイン）
- Passkey (WebAuthn) 認証 + JWT、PC ローカルから端末追加（QR）
- 固定URL（Cloudflare Tunnel、ポート開放なし）
- watchdog 経由の自動復旧・スマホからのエージェント再起動
- 危険コマンドブロック・レート制限（1分30req）
- 会話の継続（プロジェクトごとに最後の session_id を `--resume`）／🆕新しい会話（`new_session` でリセット、汚染セッションは自動破棄）
- 📋状況ボタン（git情報を Claude Code が翻訳）
- 📅まとめボタン（今日の作業を Claude Code がレポート）
- IDEトンネル（VS Code / Cursor をブラウザで開く）
- ジョブシステム + SSE ストリーミング（長時間タスクを Cloudflare 100 秒制限から切り離し、再接続でイベントリプレイ）
- プロセス管理（dev server / test runner をスマホから起動・ログ tail）
- ファイルアップロード
- モデル切替（既定 Opus 4.8 / haiku / sonnet を UI から選択）
- /ui/ の CDN キャッシュ対策（no-cache ヘッダ + アセットのバージョン付きURL `?v=` でエッジを貫通）
- 音声入力（Web Speech API）。`🎤` で開始、resultIndex 基準で確定追記＝重複しない
- お気に入り（⭐）・送信履歴（🕘）パネル。ワンタップで入力欄に呼び戻し

## 廃止

- OpenRouter エンジン経路 → Claude Code 一本化（Maxプラン枠で動作）。
  これに伴い旧 `execute_tool`（独自 read_file / write_file / run_command）と
  そこにあった機密ファイルブロック（`.env`/鍵等）も廃止。現在ファイル操作は
  すべて Claude Code CLI のネイティブツール経由。
- Antigravity IDE 対応 → 公式リモートトンネル無いため保留
- Discord 双方向 Bot / Webhook 通知 → 廃止。操作口はスマホ PWA に一本化。
  関連ファイル（`discord_bot.py` / `notify.py`）・依存（`discord.py` / `aiohttp`）・
  `DISCORD_*` env・起動処理をすべて削除。

## 未実装・改善余地

- **ツール権限**: Claude Code は `--permission-mode bypassPermissions` で全ツール許可。
  登録プロジェクト配下に限定（`ensure_allowed_path`）はしているが、その配下の
  `.env`・鍵ファイルは Claude Code から読めてしまう。機密ファイル単位のブロックは未実装。
- 必要に応じて追記

## 登録済みプロジェクト

実体は [agent/config.json](agent/config.json)（**gitignore 済**・個人のパスを公開しないため）。
雛形は [agent/config.example.json](agent/config.example.json)。スマホUIの「＋追加」か
config.json 直接編集で登録する。ここに列挙したパス配下でのみ Claude が動く（安全柵）。

## フォーク時に変える場所（AIコーディング向け）

このリポジトリは**個人値をコードに焼かない**設計。フォークして自分用にするには、
原則 **`agent/.env` と `agent/config.json` の2ファイルだけ**を用意すればよい
（`./setup.ps1` が両方を生成する）。Claude Code に「このプロジェクトを自分用に設定して」と
頼む場合は、以下を必ず守らせる:

- **コードに個人ドメイン/パス/トークンを書き戻さない。** 公開URL・Passkey RP・CORS は
  すべて `.env` の `PUBLIC_URL` から自動導出される（[agent/auth.py](agent/auth.py) の
  `_default_rp_id()`、[agent/main.py](agent/main.py) の CORS 既定）。ハードコードしないこと。
- **`ANTHROPIC_API_KEY` を追加しない。** agent はキーが環境にあると**起動を拒否**する
  （[agent/main.py](agent/main.py) の起動ガード）。Max/Pro プラン枠を死守するための仕様。
- **`start-all.ps1` / `setup.ps1` は `$PSScriptRoot` 基準**で動く。clone 先がどこでも良いよう、
  固定の絶対パス（旧 `E:\remotes`）を書かないこと。
- 新しい登録プロジェクトは `config.json` に足す。`config.example.json` は雛形なので実パスを
  書かない。

## 起動方法

デスクトップの「PC作業のAI」アイコンをダブルクリック
→ [start-all.ps1](start-all.ps1) が cloudflared / watchdog (8765) / agent (8766) / VS Code・Cursor トンネルをウィンドウなしで起動。PID は `logs/pids/` に記録、再起動時は古い PID を kill してから上げ直す。

⚠️ Administrator では起動しない（ゾンビ化して次回起動を塞ぐため、起動スクリプトが拒否する）。

## 主要ファイル

- [agent/main.py](agent/main.py) : FastAPI 中継AI（8766） + 認証 middleware + レート制限 + 一時停止/再開 + /restart /shutdown
- [agent/watchdog.py](agent/watchdog.py) : 公開口（8765）。/start /restart 提供 + agent への HTTPS プロキシ + SSE パススルー + agent ダウン時 503。
  - **プロキシは agent のレスポンスヘッダを透過する**（hop-by-hop だけ除去）。以前は `Cache-Control` を
    落としていたため CF エッジが `/ui/*.js` を恒久キャッシュし「何度直しても更新が届かない」核心の
    原因になっていた。no-store を必ず転送すること。
- [agent/auth.py](agent/auth.py) : WebAuthn (Passkey) 検証ロジック + JWT 発行
- [agent/routers/auth_api.py](agent/routers/auth_api.py) : /auth/* エンドポイント（端末追加トークン、登録/ログイン、デバイス管理）
- [agent/routers/command.py](agent/routers/command.py) : 指示実行（Claude Code 起動）
- [agent/routers/context.py](agent/routers/context.py) : git・IDEリンク・要約
- [agent/routers/projects.py](agent/routers/projects.py) : プロジェクト管理
- [agent/routers/jobs_api.py](agent/routers/jobs_api.py) : 長時間ジョブ + SSE ストリーム
- [agent/routers/processes_api.py](agent/routers/processes_api.py) : 常駐プロセス（dev server等）管理
- [agent/routers/uploads.py](agent/routers/uploads.py) : ファイルアップロード
- [agent/jobs.py](agent/jobs.py) / [agent/processes.py](agent/processes.py) : ジョブ・プロセスのコア
- [agent/engines/claude_code.py](agent/engines/claude_code.py) : Claude Code CLI ヘッドレス起動（stream-json パース）。重要な実装上の固定:
  - `CLAUDE_CODE_DISABLE_THINKING=1` を必ず付与（拡張思考の署名崩れによる API 400 を根絶。`_subprocess_env()`）
  - モデルは `claude-opus-4-8` に明示正規化（CLI の "opus" エイリアスは旧 4.7 に解決されるため）
  - asyncio の行バッファ上限を 16MB に拡大（大ファイル内容が 1 行で来て既定 64KB を超えると Windows で破綻するため）
  - `ANTHROPIC_API_KEY` はサブプロセス env から除去（Max プラン枠死守）
  - 結果サマリは「最初の意味のある1行」を使う。旧実装は `つまり:` で機械抽出していたが
    日本語として不自然だったため廃止。
- [agent/engines/generic_cli.py](agent/engines/generic_cli.py) : **設定駆動の汎用エンジン**。Claude Code 以外の
  任意の AI コーディング CLI を**コードを書かず `config.json` の `engines` 定義だけ**で追加する。
  `claude_code.run()` と同じ契約（`job.emit`/`_cancel_cb`）。`{prompt}`/`{cwd}` 置換・`prompt_via`(stdin|arg)・
  `strip_env`（エンジン別のAPIキー課金回避）。リッチ表示はせず素テキストを token/done で返す“二級”対応。
  - エンジン選択は [command.py](agent/routers/command.py) の `_resolve_engine()`：`engine` 指定 →
    `config.json` の `default_engine` → 既定 `claude_code`。専用アダプタ(`DEDICATED_ENGINES`)が無い名前は
    generic_cli ＋ そのエンジン設定で起動。未知名は安全側に claude_code へフォールバック。
  - **設計方針**: 全部入りUIスイッチャは作らない。エンジン追加・カスタムは各自が
    **自分の AI エージェントにこのリポを読ませて改造**する前提（README「自分のAIエージェントでカスタム」）。
- [agent/config.json](agent/config.json) : 登録プロジェクト ＋ `default_engine` / `engines`（任意）
- [ui/index.html](ui/index.html) / [ui/app.js](ui/app.js) / [ui/sw.js](ui/sw.js) / [ui/manifest.json](ui/manifest.json) : スマホUI（PWA）。重要な実装上の固定:
  - **バージョン三点同期**: UI を変えたら `index.html` の `APP_VERSION` / `app.js` の `APP_JS_VERSION` /
    `sw.js` の `CACHE_KEY` を**必ず同じ番号に**揃えて上げる。`?v=` 付きURLでエッジを貫通し、
    自己修復ガード（index.html）が APP_VERSION と APP_JS_VERSION の食い違いを検出したら SW を
    全 unregister + 全キャッシュ削除する。緊急脱出は `?nosw=1`（全 SW 消去 + リロード）。
  - **アプリ高さは実測値に固定**: `body` の高さは `100dvh` 任せにせず `var(--app-h)`。
    `app.js` の `syncAppHeight()` が `window.visualViewport.height`（実可視領域）を `--app-h` に
    焼き込み、キーボード開閉・回転・アドレスバー伸縮すべてに追従する。viewport メタに
    `interactive-widget=resizes-content` も付与。Android Chrome の 100dvh 追従不安定で最下段
    ツールバー（🎤/送信/✕）が `overflow:hidden` の body に切られて消える事故を構造的に潰すため。
  - **下から出るドロワーは `.open { bottom:0 }` CSS が必須**（jobs/procs/addProject/fileTree/idePicker）。
    JS は `classList.add("open")` するだけなので、この CSS が無いと画面外のまま＝ボタン無反応に見える。
  - **再接続通知は `#connBar`（position:fixed）だけに出す**。`addMsg` で #messages に積むと最後の行として
    入力欄上に居座り、短い画面でツールバーを押し出す。`setConnBar()` で表示/消去、`finish()` で必ず消す。
  - **onclick 属性に const 変数（例: `$instruction`）を書かない**。app.js は IIFE でないので top-level
    `function` はグローバルだが `const` は非公開＝onclick から ReferenceError。動的HTMLの操作は
    `addEventListener` で配線するか、グローバル `function` だけを onclick から呼ぶ。
- [ui/mic-dictation.js](ui/mic-dictation.js) / [ui/mic-dictation.test.js](ui/mic-dictation.test.js) :
  音声入力コアロジックと単体テスト（`node --test ui/mic-dictation.test.js`）。app.js の onresult と
  同じ不変条件（resultIndex 基準で確定追記・interim は累積しない・重複しない）をミラーして担保。
- [start-all.ps1](start-all.ps1) : 統合起動スクリプト
- `tunnel-setup/cloudflared.exe` : Cloudflare Tunnel バイナリ
- `agent/.env` : APIキー・トークン（gitignore）
- `logs/` : 各プロセスのログ、`logs/pids/` に PID、`logs/jobs/` `logs/processes/` にジョブ・プロセスごとの履歴

## 認証

`agent/main.py` の middleware が三層で受ける（上から優先）:

1. **Passkey ログイン後の JWT** — スマホはまずこれ。`auth_api` で発行。
   デバイスを `/auth/devices` から削除すると JWT も即座に失効する (`auth.verify_jwt` の生存チェック)。
2. **AGENT_TOKEN**（`.env`） — bootstrap 用。passkey 登録済みかつリモートからの場合は拒否（need_passkey=true）。
   デフォルト値 (`change-me-now` 等) で起動しようとすると agent/watchdog は SystemExit。
3. **127.0.0.1 ローカル** — 認証なしで通す（PC からの端末追加・初期設定用）。
   ただし「真のローカル」のみ。watchdog 経由で CF Tunnel から入ってきた
   リクエストは agent から見ると 127.0.0.1 だが、`cf-connecting-ip` を
   検出して watchdog が `X-Via-Watchdog: 1` を強制付与し、agent はこれを
   ローカル扱いしない（`auth.is_truly_local`）。

`/auth/status` `/auth/register/*` `/auth/login/*` `/health` `/ui/*` は素通し。
ただし `/auth/register/token` は内部で `is_truly_local` チェックあり。
固定URL: `.env` の `PUBLIC_URL`（自分の Cloudflare Tunnel ドメイン）

レート制限: 認証済み 30 req/min/デバイス、未認証 10 req/min/IP。
CF 経由の未認証攻撃は全部 127.0.0.1 にまとまるので、未認証プールは
意図的に厳しくして総攻撃量を絞っている。

`/command` `/jobs` `/context` `/processes/run` の `project_path` /
`cwd` は `agent/config.json` の登録済プロジェクト配下のみ許可
（`routers/projects.ensure_allowed_path`）。任意ディレクトリで Claude
や任意コマンドを走らせないための防御。

## 作業メモ

ここに追記するとスマホエージェントの文脈になります。
