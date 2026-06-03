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
