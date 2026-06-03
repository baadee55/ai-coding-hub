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
    },
  };

  function detect() {
    const saved = localStorage.getItem("lang");
    if (saved && DICT[saved]) return saved;
    const n = (navigator.language || "en").toLowerCase();
    return n.startsWith("ja") ? "ja" : "en";
  }

  let LANG = detect();

  function t(key) {
    return (DICT[LANG] && DICT[LANG][key]) ||
           (DICT.ja && DICT.ja[key]) || key;
  }

  function apply(root) {
    const r = root || document;
    r.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    r.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    r.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    r.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
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
