// ===== 軽量 i18n 土台 =====
// 使い方:
//   HTML 要素に  data-i18n="key"（textContent）/ data-i18n-html="key"（innerHTML）/
//                data-i18n-ph="key"（placeholder）/ data-i18n-title="key"（title）を付ける。
//   JS からは window.t("key")。言語切替は window.setLang("en"|"ja")。
//
// 言語を増やすには DICT に辞書を1つ足すだけ（AI エージェントに頼める）。
// 既定は navigator.language（ja* なら日本語、それ以外は英語）。localStorage で固定。
//
// ※ 未翻訳キーは現在言語→日本語→キー名の順でフォールバック。タグを付けていない
//   要素（app.js が動的に出す文言など）はそのまま残る＝“土台”。辞書とタグを足して拡張する。
(function () {
  const DICT = {
    ja: {
      "header.sub": "PCのAI作業の続きをスマホから",
      "status.checking": "確認中",
      "status.running": "稼働中",
      "status.paused": "休止中",
      "status.disconnected": "切断",
      "status.agentDown": "エージェント停止中",
      "status.restarting": "再起動中",
      "status.stopped": "停止済み",
      "status.reconnecting": "↻ 再接続中…",
      "setup.title": "🔌 はじめに接続設定",
      "setup.desc": "PCのエージェントに接続するために<br>URLとトークンを設定してください。<br>QRコードをスキャンすると自動入力されます。",
      "setup.url": "エージェントURL",
      "setup.token": "トークン（パスワード）",
      "setup.tokenPh": "トークンを貼り付け",
      "setup.connect": "接続する",
      "proj.select": "プロジェクトを選択",
      "input.ph": "指示を入力…（🕘で履歴・⭐でお気に入り）",
      "settings.title": "⚙️ 設定",
      "settings.connection": "接続",
      "settings.authChecking": "認証状態を確認中…",
      "settings.ccModelLabel": "モデル（任意・空欄でデフォルト）",
      "model.default": "デフォルト（Opus 4.8・作業向け）",
      "model.haiku": "Haiku（速い・上限消費少）",
      "model.sonnet": "Sonnet（高精度・標準）",
      "model.opus": "Opus 4.8（最強）",
      "settings.permLabel": "Claude Code 権限モード",
      "perm.bypass": "全部自動承認（おまかせ）",
      "perm.acceptEdits": "編集は自動・Bashは確認",
      "perm.default": "毎回確認（推奨されない）",
      "perm.plan": "プランのみ作成（実行しない）",
      "settings.vscodeTunnel": "VS Code トンネル",
      "settings.tunnelNameLabel": "トンネル名（start-all.ps1 の --name と合わせる）",
      "settings.passkey": "スマホ認証（Passkey）",
      "passkey.checking": "確認中…",
      "passkey.login": "🔓 Passkey でログイン",
      "passkey.registerPc": "📱 この端末を Passkey 登録（QR 経由）",
      "passkey.add": "📱 別の端末を追加（PC で実行 → QR）",
      "drawer.save": "保存",
      "drawer.install": "📲 ホーム画面にアプリを追加",
      "settings.actions": "操作",
      "action.restart": "🔄 エージェントを再起動",
      "action.clearHistory": "🗑️ 会話履歴を削除",
      "action.shutdown": "⏹ エージェントを完全停止",
      "addProj.title": "＋ プロジェクト追加",
      "addProj.desc": "フォルダのパスを指定してプロジェクトを登録します。",
      "addProj.namePh": "プロジェクト名（例: myapp）",
      "addProj.pathPh": "フォルダパス（例: E:\\myapp）",
      "btn.cancel": "キャンセル",
      "btn.add": "追加",
      "fileTree.title": "ファイル",
      "jobs.title": "🗂 ジョブ履歴（このプロジェクト）",
      "jobs.desc": "実行中・完了したジョブを再表示できます。タップで会話に復元。",
      "procs.title": "🚀 プロセス（dev server 等）",
      "procs.cmdPh": "例: npm run dev / pytest -q",
      "procs.run": "▶ 起動",
      "procs.tailClose": "閉じる",
      "idePicker.title": "プロジェクトを選択",
      "idePicker.desc": "タップでそのプロジェクトをIDEで開いて、AIへの指示画面もスコープを切り替えます。",
      "qr.title": "📱 別の端末で開いて登録",
      "qr.desc": "スマホで下の QR をスキャン → ブラウザで開く → そのまま Passkey 登録に進みます。<br><b style=\"color:var(--yellow);\">10 分以内に</b> 完了してください。",
      "common.close": "閉じる",
      "install.title": "📲 ホーム画面に追加",
      "install.android": "① 右上「⋮」メニューをタップ<br>② <b style=\"color:var(--text);\">「ホーム画面に追加」</b> をタップ<br>③ 「追加」で完了",
      "install.ios": "① 下部の <b style=\"color:var(--text);\">「共有」ボタン（□↑）</b> をタップ<br>② <b style=\"color:var(--text);\">「ホーム画面に追加」</b> をタップ<br>③ 「追加」で完了",
      "install.done": "✅ すでにアプリとしてインストール済みです。",
      "install.installBtn": "インストール",
      "welcome.title": "PCに接続しました",
      "welcome.desc": "テキストで指示するだけでAIがPCを操作します。<br>コードの修正・ファイル操作・コマンド実行など何でも。",
      "welcome.hint1": "Git バーの <b>⬡ VS Code</b> ボタンで、選んだプロジェクトをブラウザのVS Codeで開ける",
      "welcome.hint2": "<b>Git Pull/Commit/Push</b> ボタンで素早くgit操作",
      "welcome.hint3": "よく使う指示は<b>お気に入り</b>に登録してワンタップ送信",
      "welcome.hint4": "入力欄の<b>🕘</b>ボタンで過去に送った指示を呼び出せる（タップで再利用）",
      "welcome.seeAll": "❓ 使い方をすべて見る",
      "fav.hint": "よく使う指示を登録できます。",
      "confirm.restart": "エージェントを再起動します。\n約10秒間接続が切れます。",
      "confirm.clearHistory": "会話履歴を削除しますか？",
      "confirm.shutdown": "エージェントを完全停止します。\n再起動はPCで「AI hub β」を起動し直してください。",
      "confirm.deleteDevice": "デバイス {id} を削除しますか？このデバイスからは再ログインできなくなります。",
      "pk.authed": "<span style=\"color:var(--green);\">✅ Passkey で認証済み</span>（{name}・残り {days}日）",
      "pk.tokenMode": "<span style=\"color:var(--yellow);\">🔑 トークンで接続中</span>（Passkey 未登録）",
      "pk.loggedIn": "<span style=\"color:var(--green);\">✅ ログイン中: {name} (残り {days}日)</span>",
      "pk.registeredNotLoggedIn": "Passkey 登録済み・未ログイン。下のボタンで認証してください。",
      "pk.authDialog": "認証ダイアログを表示中…",
      "pk.regDone": "✅ Passkey 登録完了",
      "pk.regFail": "Passkey 登録失敗: {msg}",
      "pk.regTitle": "この端末を Passkey 登録",
      "pk.regBtn": "🔓 Passkey 登録する",
      "conn.notRecovered": "接続が回復しませんでした。指示はPCで継続中の可能性があります（🗂ジョブ履歴から再表示できます）。",
      "common.thisDevice": "この端末",
      "restart.inProgress": "🔄 再起動中… 自動で再接続します",
      "restart.done": "✅ 再起動完了",
      "restart.failed": "再起動に失敗しました。PCを確認してください",
      "history.cleared": "履歴を削除しました",
      "shutdown.done": "エージェントを停止しました",
      "pk.authedShort": "<span style=\"color:var(--green);\">✅ Passkey で認証済み</span>",
      "pk.unauthed": "<span style=\"color:var(--muted);\">未認証（下の Passkey セクションから設定）</span>",
      "common.delete": "削除",
      "common.deleted": "削除しました",
    },
    en: {
      "header.sub": "Your PC's AI — from your phone",
      "status.checking": "Checking…",
      "status.running": "running",
      "status.paused": "paused",
      "status.disconnected": "Disconnected",
      "status.agentDown": "Agent stopped",
      "status.restarting": "Restarting…",
      "status.stopped": "Stopped",
      "status.reconnecting": "↻ Reconnecting…",
      "setup.title": "🔌 First, connect",
      "setup.desc": "To reach your PC's agent,<br>set the URL and token.<br>Scanning the QR code fills them in automatically.",
      "setup.url": "Agent URL",
      "setup.token": "Token (password)",
      "setup.tokenPh": "Paste your token",
      "setup.connect": "Connect",
      "proj.select": "Select a project",
      "input.ph": "Type an instruction…  (🕘 history · ⭐ favorites)",
      "settings.title": "⚙️ Settings",
      "settings.connection": "Connection",
      "settings.authChecking": "Checking auth status…",
      "settings.ccModelLabel": "Model (optional; blank = default)",
      "model.default": "Default (Opus 4.8 · for work)",
      "model.haiku": "Haiku (fast · low usage)",
      "model.sonnet": "Sonnet (accurate · standard)",
      "model.opus": "Opus 4.8 (most capable)",
      "settings.permLabel": "Claude Code permission mode",
      "perm.bypass": "Auto-approve everything (hands-off)",
      "perm.acceptEdits": "Edits auto · Bash asks",
      "perm.default": "Ask every time (not recommended)",
      "perm.plan": "Plan only (no execution)",
      "settings.vscodeTunnel": "VS Code tunnel",
      "settings.tunnelNameLabel": "Tunnel name (match --name in start-all.ps1)",
      "settings.passkey": "Phone auth (Passkey)",
      "passkey.checking": "Checking…",
      "passkey.login": "🔓 Sign in with Passkey",
      "passkey.registerPc": "📱 Register this device (via QR)",
      "passkey.add": "📱 Add another device (run on PC → QR)",
      "drawer.save": "Save",
      "drawer.install": "📲 Add app to home screen",
      "settings.actions": "Actions",
      "action.restart": "🔄 Restart agent",
      "action.clearHistory": "🗑️ Clear conversation history",
      "action.shutdown": "⏹ Stop agent completely",
      "addProj.title": "＋ Add project",
      "addProj.desc": "Register a project by giving its folder path.",
      "addProj.namePh": "Project name (e.g. myapp)",
      "addProj.pathPh": "Folder path (e.g. E:\\myapp)",
      "btn.cancel": "Cancel",
      "btn.add": "Add",
      "fileTree.title": "Files",
      "jobs.title": "🗂 Job history (this project)",
      "jobs.desc": "Re-open running or finished jobs. Tap to restore into the chat.",
      "procs.title": "🚀 Processes (dev server, etc.)",
      "procs.cmdPh": "e.g. npm run dev / pytest -q",
      "procs.run": "▶ Start",
      "procs.tailClose": "Close",
      "idePicker.title": "Select a project",
      "idePicker.desc": "Tap to open that project in the IDE and switch the instruction scope too.",
      "qr.title": "📱 Open on another device to register",
      "qr.desc": "Scan the QR below with your phone → open in the browser → continue to Passkey registration.<br>Finish <b style=\"color:var(--yellow);\">within 10 minutes</b>.",
      "common.close": "Close",
      "install.title": "📲 Add to home screen",
      "install.android": "① Tap the “⋮” menu (top right)<br>② Tap <b style=\"color:var(--text);\">“Add to Home screen”</b><br>③ Tap “Add” to finish",
      "install.ios": "① Tap the <b style=\"color:var(--text);\">Share button (□↑)</b> at the bottom<br>② Tap <b style=\"color:var(--text);\">“Add to Home Screen”</b><br>③ Tap “Add” to finish",
      "install.done": "✅ Already installed as an app.",
      "install.installBtn": "Install",
      "welcome.title": "Connected to your PC",
      "welcome.desc": "Just type and the AI operates your PC.<br>Code edits, file ops, running commands — anything.",
      "welcome.hint1": "Open the selected project in browser VS Code via the <b>⬡ VS Code</b> button in the Git bar",
      "welcome.hint2": "Quick git with the <b>Git Pull/Commit/Push</b> buttons",
      "welcome.hint3": "Save frequent instructions to <b>Favorites</b> for one-tap send",
      "welcome.hint4": "Recall past instructions with the <b>🕘</b> button in the input (tap to reuse)",
      "welcome.seeAll": "❓ See the full guide",
      "fav.hint": "You can save frequently used instructions.",
      "confirm.restart": "Restart the agent?\nThe connection will drop for about 10 seconds.",
      "confirm.clearHistory": "Delete the conversation history?",
      "confirm.shutdown": "Stop the agent completely?\nTo restart, launch “AI hub β” again on your PC.",
      "confirm.deleteDevice": "Delete device {id}? You will not be able to sign in again from this device.",
      "pk.authed": "<span style=\"color:var(--green);\">✅ Authenticated with Passkey</span> ({name} · {days}d left)",
      "pk.tokenMode": "<span style=\"color:var(--yellow);\">🔑 Connected with token</span> (Passkey not registered)",
      "pk.loggedIn": "<span style=\"color:var(--green);\">✅ Signed in: {name} ({days}d left)</span>",
      "pk.registeredNotLoggedIn": "Passkey registered but not signed in. Tap the button below to authenticate.",
      "pk.authDialog": "Showing the authentication dialog…",
      "pk.regDone": "✅ Passkey registered",
      "pk.regFail": "Passkey registration failed: {msg}",
      "pk.regTitle": "Register this device with Passkey",
      "pk.regBtn": "🔓 Register Passkey",
      "conn.notRecovered": "Could not recover the connection. Your instruction may still be running on the PC (re-open it from 🗂 Job history).",
      "common.thisDevice": "this device",
      "restart.inProgress": "🔄 Restarting… it will reconnect automatically",
      "restart.done": "✅ Restart complete",
      "restart.failed": "Restart failed. Please check your PC.",
      "history.cleared": "History cleared",
      "shutdown.done": "Agent stopped",
      "pk.authedShort": "<span style=\"color:var(--green);\">✅ Authenticated with Passkey</span>",
      "pk.unauthed": "<span style=\"color:var(--muted);\">Not authenticated (set up in the Passkey section below)</span>",
      "common.delete": "Delete",
      "common.deleted": "Deleted",
      "help.body": '<div class="help-title">❓ Guide / button reference</div><div class="help-lead">Just type an instruction and the AI on your PC (Claude Code, by default) edits files, runs commands, and more. Here is what each button does.</div><h4>Header (top row)</h4><div class="help-row"><span class="help-key">🔄</span><span><b>Update app</b>. Pull the latest UI (if it looks out of date).</span></div><div class="help-row"><span class="help-key">❓</span><span>Open <b>this help</b>.</span></div><div class="help-row"><span class="help-key">⚙️</span><span><b>Settings</b>: agent URL, model, permissions, Passkey, restart agent, etc.</span></div><div class="help-row"><span class="help-key">●</span><span>Connection status (running / disconnected).</span></div><h4>VS Code in the Git bar</h4><div class="help-row"><span class="help-key">⬡</span><span><b>VS Code</b>. Open the selected project in browser VS Code (vscode.dev) — handy on a tablet or big screen.</span></div><h4>Project row</h4><div class="help-row"><span class="help-key">▾</span><span><b>Project select</b>. Switch the target folder for instructions (swipe left/right too).</span></div><div class="help-row"><span class="help-key">🆕</span><span><b>New conversation</b>. Cut the prior context and start fresh (when topics get mixed).</span></div><div class="help-row"><span class="help-key">🗂</span><span><b>Job history</b>. List of running/finished instructions. Tap to restore into the chat.</span></div><div class="help-row"><span class="help-key">🚀</span><span><b>Process manager</b>. Start long-running things like <code>npm run dev</code> or <code>pytest</code> and view logs.</span></div><div class="help-row"><span class="help-key">📋</span><span><b>Status explainer</b>. The AI explains git changes in plain language.</span></div><div class="help-row"><span class="help-key">📅</span><span><b>Daily summary</b>. The AI reports the work done today.</span></div><div class="help-row"><span class="help-key">📂</span><span><b>File list</b>. Browse inside the project and check contents.</span></div><div class="help-row"><span class="help-key">＋</span><span><b>Add project</b>. Register a folder path.</span></div><h4>Git operations (save &amp; share changes)</h4><div class="help-lead" style="margin:6px 0 10px;">Git records the history of your work and saves/shares it online (e.g. GitHub). The buttons below act on the selected project. Even without knowing the jargon, pressing them in the order below works.</div><div class="help-row"><span class="help-key">↓</span><span><b>Pull (fetch)</b>. Bring the latest from online to your machine. Press it <b>before starting</b> to pick up changes made on another PC.</span></div><div class="help-row"><span class="help-key">≡</span><span><b>Status (check)</b>. See which files you changed, as a list. For "what did I touch?".</span></div><div class="help-row"><span class="help-key">✓</span><span><b>Commit (save)</b>. Give the changes a message and <b>record them in local history</b>. A message prompt appears. Think of it as a save point. <u>All changes are recorded together.</u></span></div><div class="help-row"><span class="help-key">↑</span><span><b>Push (send)</b>. Send committed changes <b>online (e.g. GitHub) to share / back up</b>. <u>Commit alone does not reach the cloud — Push is required at the end.</u></span></div><div class="help-row" style="opacity:.85;"><span class="help-key">▶</span><span><b>Order</b>: ① ↓Pull (update first) → ② work (instruct/edit) → ③ ≡Status (check) → ④ ✓Commit (save) → ⑤ ↑Push (send).</span></div><h4>Input area</h4><div class="help-row"><span class="help-key">⭐</span><span><b>Favorites</b>. Save frequent instructions for one-tap send.</span></div><div class="help-row"><span class="help-key">📎</span><span><b>Attach</b>. Attach images or files to your instruction.</span></div><div class="help-row"><span class="help-key">📝</span><span><b>Tasks</b>. Split work into steps and run them in order.</span></div><div class="help-row"><span class="help-key">🎤</span><span><b>Voice input</b>. What you say goes into the input box.</span></div><div class="help-row"><span class="help-key">✕</span><span><b>Stop</b>. Shown only while running; stops the work.</span></div><div class="help-row"><span class="help-key">↑</span><span><b>Send</b>. Send the instruction (Enter inserts a newline, to avoid accidental sends).</span></div><h4>Handy gestures</h4><div class="help-row"><span class="help-key">🕘</span><span>Recall past instructions with the <b>🕘 button</b> in the input (tap to fill). On PC, when the box is empty, the <b>↑↓ keys</b> work too.</span></div><div class="help-row"><span class="help-key">↔</span><span><b>Swipe left/right</b> on the message area to switch projects.</span></div><div class="help-row"><span class="help-key">⤓</span><span><b>Pull down</b> at the top to refresh. <b>Long-press</b> a message to copy.</span></div>',
    },
  };

  function detect() {
    const saved = localStorage.getItem("lang");
    if (saved && DICT[saved]) return saved;
    const n = (navigator.language || "en").toLowerCase();
    return n.startsWith("ja") ? "ja" : "en";
  }

  let LANG = detect();

  function t(key, params) {
    let s = (DICT[LANG] && DICT[LANG][key]) ||
            (DICT.ja && DICT.ja[key]) || key;
    if (params) {
      for (const k in params) s = s.split("{" + k + "}").join(params[k]);
    }
    return s;
  }

  // 要素の「元の中身」(=HTMLに書かれた日本語) を一度だけキャッシュ。
  // → 日本語は元の中身を使う＝辞書に ja を持たなくてよい。英語等は辞書、無ければ元に戻す。
  //   （大きな本文ブロックを英語辞書1キーだけで翻訳できる）
  function orig(el, kind) {
    const k = "__i18n_" + kind;
    if (el[k] === undefined) {
      el[k] = kind === "html" ? el.innerHTML
            : kind === "ph" ? (el.getAttribute("placeholder") || "")
            : kind === "title" ? (el.getAttribute("title") || "")
            : el.textContent;
    }
    return el[k];
  }
  function tr(key, origVal) {
    if (LANG === "ja") return (DICT.ja && DICT.ja[key]) || origVal;
    return (DICT[LANG] && DICT[LANG][key]) || (DICT.ja && DICT.ja[key]) || origVal;
  }

  function apply(root) {
    const r = root || document;
    r.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = tr(el.getAttribute("data-i18n"), orig(el, "text"));
    });
    r.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = tr(el.getAttribute("data-i18n-html"), orig(el, "html"));
    });
    r.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", tr(el.getAttribute("data-i18n-ph"), orig(el, "ph")));
    });
    r.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", tr(el.getAttribute("data-i18n-title"), orig(el, "title")));
    });
    document.documentElement.lang = LANG;
  }

  function updateToggle() {
    const b = document.getElementById("langToggleBtn");
    if (!b) return;
    b.textContent = "🌐";  // アイコンのみ（ヘッダ幅を食わない）。切替先は title に
    b.title = LANG === "ja" ? "Language: 日本語 → English" : "Language: English → 日本語";
  }

  function setLang(l) {
    if (!DICT[l]) return;
    LANG = l;
    localStorage.setItem("lang", l);
    apply();
    updateToggle();
  }

  window.t = t;
  window.setLang = setLang;
  window.applyI18n = apply;
  window.getLang = () => LANG;

  function init() {
    apply();
    updateToggle();
    const b = document.getElementById("langToggleBtn");
    if (b) b.addEventListener("click", () => setLang(LANG === "ja" ? "en" : "ja"));
  }
  // 静的読込(<head>)でも、app.js ローダからの後差し込みでも確実に適用されるよう
  // DOM 準備状態を見て即時/遅延を切り替える。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
