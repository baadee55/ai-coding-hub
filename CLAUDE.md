# AI Coding Hub — design notes & fixed constraints (for AI coding agents)

> Read this before changing the code. English summary: a phone PWA → Cloudflare Tunnel → watchdog (8765) →
> FastAPI agent (8766) → Claude Code CLI on your own PC (your own plan, no API billing).
> Hard rules: never set `ANTHROPIC_API_KEY`; never hardcode personal values (domains/paths/tokens) — everything
> per-user lives in `agent/.env` and `agent/config.json` (both gitignored); commands run only under registered projects.
>
> 必要時に grep して引く。

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
Claude Code CLI（Claude 有料プラン枠: Pro/Max、追加課金なし、既定 最新Opus）
    ↓ tool 呼び出し
PC のファイル・ターミナル
```

⚠️ **重要：`ANTHROPIC_API_KEY` を環境変数や .env に絶対に設定しないこと。**
設定されていると Claude Code が Max プランではなく API 課金で動き、想定外の請求が来る（Issue #37686 で 2 日で $1,800 の事例あり）。

### 設計のキモ（なぜこの形？）

- **ポート開放ゼロ** … Cloudflare Tunnel が外→中をつなぐので、ルーター設定なしで安全に公開。
- **watchdog を挟む** … agent が落ちてもスマホから再起動でき、止まらない。
- **Max プラン枠で実行** … API キーをサブプロセスから消すことで、想定外の課金を構造的に防止。
- **登録プロジェクト配下を起点に実行** … 作業ディレクトリの制限（OS レベルのサンドボックスではない。`project_path` 未指定は許容され、その場合 agent の cwd で動く）。

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
- モデル切替（既定 最新Opus / haiku / sonnet を UI から選択）
- /ui/ の CDN キャッシュ対策（no-cache ヘッダ + アセットのバージョン付きURL `?v=` でエッジを貫通）
- 音声入力（Web Speech API）。`🎤` で開始、resultIndex 基準で確定追記＝重複しない
- お気に入り（⭐）・送信履歴（🕘）パネル。ワンタップで入力欄に呼び戻し
- 🔒金庫（Vault）双方向: 本文に `{{名前}}` で機密注入（A）/ `[[secret:名前]]` で受信分離（B）。
  実値はスマホ端末内のみ（暗号化 localStorage）。指紋(WebAuthn)/PIN で開錠、60s 無操作で自動再ロック。
  逆マスク+自動パターンマスクで events/ログに実値を残さない（単体+統合テスト）。詳細は下の【実装ガイド】。

## 🔒 金庫（Vault）機能 — 設計と不変条件【実装ガイド】

**目的**: API キー・パスワード・ニーモニック・接続トークン等の機密値を、チャット本文
（履歴・画面・ログに残る）に**書かずに**やり取りする。下部ツールバーの 🔒 ボタンから開く
ドロワーで、**指紋（WebAuthn）または暗証番号（PIN）**で開錠する。📝タスク化ボタンを
これに置き換える方針（タスク化は入力テキストの定型置換だけで使われていない）。

**双方向**:
- **A方向（スマホ→PC・値を渡す）**: 本文に `{{名前}}` と書く → 送信直前にサーバが値を注入。
  履歴・ログには `{{名前}}` だけ残る。
- **B方向（PC→スマホ・値を受け取る）**: Claude が機密を `[[secret:名前]]値[[/secret]]` で
  囲んで出力 → engine が配信前に実値を金庫チャネルへ分離、本文には `[[secret:名前]]` だけ残す。
  スマホで開錠時のみ実値表示。

**値の保存場所**: スマホ端末内のみ（localStorage を暗号化）。**サーバには保存しない**。
PC 側に機密を貯めない＝[agent/main.py](agent/main.py) 起動ガードや公開リポの思想と整合。

### 絶対に守る不変条件（これが崩れると機能の意味が消える）

1. **`job.instruction` / `events[]` / `logs/jobs/*.jsonl` には実値を絶対に入れない。**
   置換は [engines/claude_code.py](agent/engines/claude_code.py) の instruction 組み立て直前
   （一時ファイル書き込み時）だけ。置換後の文字列を `job` オブジェクトに戻さない。
   ⚠️ 漏洩経路として既知: [jobs.py](agent/jobs.py) `emit()` が**全イベントをディスクに追記**する。
   ここに実値が乗ると平文でディスクに残る。
2. **逆マスク／分離（A/B 共通の本丸）**: [claude_code.py](agent/engines/claude_code.py) の
   `_wrap_emit_with_vault` が `job.emit()` を**全ジョブで常時**ラップし、通る全文字列
   （token / result / tool_use input / tool_result）を配信前にサニタイズする。
   - **B方向の分離は secrets の有無に関わらず常時**（`[[secret:名前]]値[[/secret]]` の実値を
     meta へ分離・本文は `[[secret:名前]]` だけ／囲みが token を跨いでも閉じるまで抑止）。
     `/command` 経路や金庫未開錠でも、Claude が囲んで返した機密が events/ログ/画面に残らない。
   - **既知値の逆マスク（実値→`{{名前}}`）と自動パターンマスクは secrets ありジョブ限定**。
   忘れると Claude の復唱や `done` サマリ経由で漏れる。**単体テスト必須**
   （[test_vault_integration.py](agent/engines/test_vault_integration.py) / [test_vault.py](agent/engines/test_vault.py)）。
3. **自動パターンマスク（取りこぼし対策・secrets ありのみ）**: 囲み規約に加え、`sk-` 始まり・
   長い英数字列等を正規表現で自動マスク。誤検出は許容（漏らすよりマシ）。ただし git SHA(40hex)
   等を誤爆するため、secrets を使わない通常ジョブの出力には掛けない（B方向の分離だけ常時効く）。
4. **開錠は自動タイムアウト**: 一定秒（例 60s）無操作・送信後に再ロック。値表示は 👁 長押し時のみ、
   既定は `••••`。クリップボード経由を避ける（ニーモニック対策）。
5. **PIN は端末 JWT とは別の二要素**。PC が乗っ取られても金庫だけは開かない設計。

### 受け入れたリスク（仕様として明記・防がない）

- ⚠️ **ファイル書き出し**: `--permission-mode bypassPermissions`（[command.py](agent/routers/command.py)）
  のため、注入値を Claude が `Write`/`Bash` でファイルに書くのは**止められない**。本機能は
  「**履歴・画面・通信ログに残さない**」防御であって、Claude の行動自体は信頼前提。
- ⚠️ **B方向の規約破り**: Claude が `[[secret:]]` で囲まず地の文に機密をベタ書きしたら、
  自動パターンマスクをすり抜けた分は漏れる。完全防止は不可（LLM の確率的挙動）。
- **指紋開錠の材料（v106 で平文保存を廃止）**: 端末の localStorage（`vaultFpUnlock_v1`）には
  ランダム鍵で AES-GCM ラップした PIN（`{v:2,iv,ct}`）だけを置き、鍵本体は PC 側
  `agent/config/credentials.json` に credential 紐づけで保存
  （`vault_wrap_key`・設定は JWT 必須の `POST /auth/vault-key`）。鍵の返却は WebAuthn 認証成功時の
  `/auth/login/finish` 応答（`vault_key`）のみ＝**端末ストレージを読めるだけでは PIN は取れない**。
  旧平文材料は次回の指紋開錠 or PIN 開錠時に自動でラップ形式へ移行・毎回鍵ローテーション
  （[ui/app.js](ui/app.js) `vaultSetFpMaterial` / `vaultFpBtn`）。PC 側が奪われた場合は
  ラップ鍵も奪われるが、PC には agent 本体と全プロジェクトがある＝金庫より先に本丸が落ちる前提。

## 登録済みプロジェクト

実体は `agent/config.json`（**gitignore 済**・個人のパスを公開しないため）。
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
  固定の絶対パスを書かないこと。
- 新しい登録プロジェクトは `config.json` に足す。`config.example.json` は雛形なので実パスを
  書かない。

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
- [agent/routers/jobs_api.py](agent/routers/jobs_api.py) : 長時間ジョブ + SSE ストリーム（スマホUIの
  実指示経路。🔒金庫の `secrets` はここだけが engine へ渡す）。⚠️ エンジンは **claude_code 固定**
  （`req.engine`/`default_engine` は見ない）。汎用エンジン（generic_cli）は `/command` 経由のみ。
- [agent/routers/processes_api.py](agent/routers/processes_api.py) : 常駐プロセス（dev server等）管理
- [agent/routers/uploads.py](agent/routers/uploads.py) : ファイルアップロード
- [agent/jobs.py](agent/jobs.py) / [agent/processes.py](agent/processes.py) : ジョブ・プロセスのコア
- [agent/lifecycle.py](agent/lifecycle.py) : 起動時に前回クラッシュで終端の無いジョブログを `interrupted` で締める／
  agent 稼働中だけ Windows のスリープを抑止（`SetThreadExecutionState`・プロセス終了で解除）
- [agent/push.py](agent/push.py) / [agent/routers/push_api.py](agent/routers/push_api.py) : Web Push（VAPID）。
  完了通知をスリープ中のスマホにも届ける。鍵と購読は `agent/config/`（gitignore 済み）。`/push/*`
- [agent/security_log.py](agent/security_log.py) : ログイン失敗・認証拒否・レート超過を `logs/security.jsonl` に軽量記録
- [agent/engines/claude_code.py](agent/engines/claude_code.py) : Claude Code CLI ヘッドレス起動（stream-json パース）。重要な実装上の固定:
  - 拡張思考は既定オン。オフ時のみ `CLAUDE_CODE_DISABLE_THINKING=1`（署名崩れによる API 400 対策。`_subprocess_env()`）。オンで 400 が出たら 1 回だけ thinking 無しで自動リトライ
  - 作業モデルは `get_work_model()` が「最新 Opus」を解決（`run()`/`run_oneshot()` が opus/空指定時に使用）。CLI エイリアス `opus` は新版公開後しばらく旧版に遅延解決される癖があるため、エイリアス実解決先と既知の最新明示ID `_OPUS_PIN`（現 `claude-opus-5-5`）を比べ新しい方を採用。比較は `_opus_version_key()`（末尾8桁の日付を剥がしてから major/minor 比較。剥がさないと `claude-opus-5-20260401` が 5.20260401 と読めて誤判定）。エイリアスが追い付けば以後エイリアス＝将来更新に自動追随。24h キャッシュ＋裏更新。実応答モデルは assistant `message.model` で検出し `job.model` へ同期。⚠️コード変更はエージェント再起動で有効。
  - asyncio の行バッファ上限を 16MB に拡大（大ファイル内容が 1 行で来て既定 64KB を超えると Windows で破綻するため）
  - `ANTHROPIC_API_KEY` はサブプロセス env から除去（Max プラン枠死守）
  - 結果サマリは「最初の意味のある1行」を使う。
  - **hub の常駐システム説明** `AIHUB_SYSTEM_BRIEFING` を毎ジョブ `--append-system-prompt-file`
    で付与（一時ファイル経由・`finally` で削除）。作業AIに「スマホ越しのリレーである」前提と
    🔒金庫の双方向作法（`{{名前}}`は実値注入済み＝そのまま使う／機密は`[[secret:名前]]値[[/secret]]`
    で囲んで返す）を最初から分からせる。**別プロジェクト配下でも金庫が未知語にならないための要**。
    指示文・events・logs には載らない（履歴・機密を汚さない）＝[command.py](agent/routers/command.py) の
    旧 `VAULT_PREAMBLE` は短い `VAULT_REMINDER` に縮小済み。書式は engines/vault.py と一致させる。
    - **言語ミラー**: ブリーフィングに「指示文と同じ言語で返答する」を明記済み（英語の指示は英語、
      日本語は日本語、他言語も同様）。返答言語が文脈任せでブレるのを防ぐ。
  - **がんばり度（effort）**: `run(effort=...)` で CLI ネイティブの `--effort`（low/medium/high/
    xhigh/max）を渡す。未指定なら CLI 既定。`CLAUDE_CODE_DISABLE_THINKING=1` とは独立に効く
    （effort は思考ブロックの署名問題と無関係なので 400 を誘発しない）。UI は ⚡ピル（`effortPill`）で
    自動/低/中/高/最高/全力を巡回し、jobs payload の `effort` で送る（[jobs_api.py](agent/routers/jobs_api.py)）。
- [agent/engines/generic_cli.py](agent/engines/generic_cli.py) : **設定駆動の汎用エンジン**。Claude Code 以外の
  任意の AI コーディング CLI を**コードを書かず `config.json` の `engines` 定義だけ**で追加する。
  `claude_code.run()` と同じ契約（`job.emit`/`_cancel_cb`）。`{prompt}`/`{cwd}` 置換・`prompt_via`(stdin|arg)・
  `strip_env`（エンジン別のAPIキー課金回避）。リッチ表示はせず素テキストを token/done で返す“二級”対応。
  - エンジン選択は [command.py](agent/routers/command.py) の `_resolve_engine()`：`engine` 指定 →
    `config.json` の `default_engine` → 既定 `claude_code`。専用アダプタ(`DEDICATED_ENGINES`)が無い名前は
    generic_cli ＋ そのエンジン設定で起動。未知名は安全側に claude_code へフォールバック。
  - **設計方針**: 全部入りUIスイッチャは作らない。エンジン追加・カスタムは各自が
    **自分の AI エージェントにこのリポを読ませて改造**する前提（README「自分のAIエージェントでカスタム」）。
- `agent/config.json` : 登録プロジェクト ＋ `default_engine` / `engines`（任意）
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
- [scripts/](scripts/) : 自動起動・自己修復（任意・**非管理者**）。`autoheal.ps1`（`/health` を
  localhost/::1/127.0.0.1 で監視→ダウンなら start-all を `-NonInteractive` で叩く）、
  `autoheal-loop.ps1`（ログオン常駐ループ）、`install-autostart.ps1`（スタートアップに lnk 登録）/
  `install-autoheal.ps1`（タスクスケジューラに登録）。⚠️ 登録するとスマホの「シャットダウン」で
  止めても5分以内に自動復活する＝恒久停止はこの登録を外す（各スクリプト冒頭の Remove コマンド参照）。
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
ただし `/auth/register/token` は内部チェックあり: **PC ローカル（`is_truly_local`）
または認証済み（AGENT_TOKEN/JWT）**のときだけ発行する（[auth_api.py](agent/routers/auth_api.py)
`_is_authenticated`）。後者により「固定URL→パスワードで接続→そのまま自分に Passkey 登録」が
QR 無しで完結する。発行時に QR を**サーバ側で生成**（`qrcode` で data URI）して返すので、
CDN ブロック環境でも端末追加 QR が必ず出る。
固定URL: `.env` の `PUBLIC_URL`（自分の Cloudflare Tunnel ドメイン）

レート制限: 認証済み 30 req/min/デバイス、未認証 10 req/min/IP。
CF 経由の未認証攻撃は全部 127.0.0.1 にまとまるので、未認証プールは
意図的に厳しくして総攻撃量を絞っている。

`/command` `/jobs` `/context` `/processes/run` の `project_path` /
`cwd` は `agent/config.json` の登録済プロジェクト配下のみ許可
（`routers/projects.ensure_allowed_path`）。任意ディレクトリで Claude
や任意コマンドを走らせないための防御（起点ディレクトリの制限であり OS サンドボックスではない）。

