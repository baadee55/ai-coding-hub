// このファイルが想定するアプリ版数。index.html の APP_VERSION と必ず一致させる
// （UI を変えてバージョンを上げるときは index.html / sw.js / ここの3点を同じ数字に）。
// index.html 側の自己修復ガードが、この値と window.APP_VERSION の不一致を検出したら
// 古い SW を unregister して取り直す。＝SW が壊れていても必ず最新へ収束する保険。
window.APP_JS_VERSION = "115";

// ===== 設定 =====
// 実行エンジンは Claude Code に一本化（Maxプラン枠で動作）。
function getSettings() {
  return {
    url:            (localStorage.getItem("agentUrl") || "").replace(/\/+$/, ""),
    token:          localStorage.getItem("token") || "",
    engine:         "claude_code",
    ccModel:        localStorage.getItem("ccModel") || "",
    ccModelCustom:  localStorage.getItem("ccModelCustom") || "",
    // 中継AI（要約・日報・ファイル一覧の橋渡し）のモデル。空欄なら最新Sonnetを使う。
    relayModel:       localStorage.getItem("relayModel") || "",
    relayModelCustom: localStorage.getItem("relayModelCustom") || "",
    // 中継AI（要約・日報・一覧）の effort。空欄なら CLI 既定に任せる。
    relayEffort:      localStorage.getItem("relayEffort") || "",
    ccEffort:       localStorage.getItem("ccEffort") || "",
    // 拡張思考。既定オン（未設定は "on" 扱い）。"off" のときだけ思考を切る。
    ccThinking:     localStorage.getItem("ccThinking") || "on",
    permMode:       localStorage.getItem("permMode") || "bypassPermissions",
    vscodeName:     localStorage.getItem("vscodeTunnelName") || "aihub-pc",
    // 🔒金庫の再認証（自動再ロック）間隔[ms]。5分〜7日でクランプ。
    // 既定は最短の5分（無設定でも最低限の保護を効かせつつ、過度に頻繁な再入力を避ける）。
    vaultLockMs:    clampVaultLockMs(parseInt(localStorage.getItem("vaultLockMs") || "", 10)),
  };
}
// 再認証間隔の範囲: 5分〜7日。範囲外・NaN は5分に丸める。
const VAULT_LOCK_MIN_MS = 5 * 60 * 1000;          // 5 分
const VAULT_LOCK_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 日
function clampVaultLockMs(ms) {
  if (!Number.isFinite(ms)) return VAULT_LOCK_MIN_MS;
  return Math.min(VAULT_LOCK_MAX_MS, Math.max(VAULT_LOCK_MIN_MS, ms));
}
function saveSettings(opts) {
  if (opts.url !== undefined)        localStorage.setItem("agentUrl", opts.url.replace(/\/+$/, ""));
  if (opts.token !== undefined)      localStorage.setItem("token", opts.token);
  if (opts.ccModel !== undefined)    localStorage.setItem("ccModel", opts.ccModel);
  if (opts.ccModelCustom !== undefined) localStorage.setItem("ccModelCustom", opts.ccModelCustom);
  if (opts.relayModel !== undefined) localStorage.setItem("relayModel", opts.relayModel);
  if (opts.relayModelCustom !== undefined) localStorage.setItem("relayModelCustom", opts.relayModelCustom);
  if (opts.relayEffort !== undefined) localStorage.setItem("relayEffort", opts.relayEffort);
  if (opts.ccEffort !== undefined)   localStorage.setItem("ccEffort", opts.ccEffort);
  if (opts.ccThinking !== undefined) localStorage.setItem("ccThinking", opts.ccThinking);
  if (opts.permMode !== undefined)   localStorage.setItem("permMode", opts.permMode);
  if (opts.vscodeName !== undefined) localStorage.setItem("vscodeTunnelName", opts.vscodeName);
  if (opts.vaultLockMs !== undefined) localStorage.setItem("vaultLockMs", String(clampVaultLockMs(opts.vaultLockMs)));
}

// ===== プロジェクト別の上書き設定 =====
// モデル/effort/thinking をプロジェクトごとに変えられる。空値は「共通設定どおり」。
// localStorage["projOverrides"] = { <projectId>: {model, modelCustom, effort, thinking} }
function getProjOverrides(pid) {
  if (!pid) return {};
  try { return (JSON.parse(localStorage.getItem("projOverrides") || "{}"))[pid] || {}; }
  catch { return {}; }
}
function saveProjOverrides(pid, ov) {
  if (!pid) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem("projOverrides") || "{}"); } catch {}
  const clean = {};
  for (const k of Object.keys(ov || {})) if (ov[k]) clean[k] = ov[k];
  if (Object.keys(clean).length) all[pid] = clean; else delete all[pid];
  localStorage.setItem("projOverrides", JSON.stringify(all));
}
// ジョブ送信に使う実効値（プロジェクト上書き → 共通設定 の順）
function effectiveJobSettings(pid) {
  const s = getSettings();
  const o = getProjOverrides(pid);
  const eff = {
    model:    (o.modelCustom || o.model) || (s.ccModelCustom || s.ccModel),
    effort:   o.effort || s.ccEffort,
    thinking: o.thinking || s.ccThinking || "on",
    hasOverride: !!(o.model || o.modelCustom || o.effort || o.thinking),
  };
  return eff;
}

// 中継AI（要約・日報・ファイル一覧）の実効モデル。
// カスタムID → 選択 → 既定（最新Sonnet）の順。作業AIとは別枠で指定できる。
const RELAY_MODEL_DEFAULT = "claude-sonnet-5";
function effectiveRelayModel() {
  const s = getSettings();
  return (s.relayModelCustom || s.relayModel || RELAY_MODEL_DEFAULT);
}
// 中継AIの実効 effort。空欄なら "" を返す（＝サーバ側で CLI 既定に任せる）。
function effectiveRelayEffort() {
  return getSettings().relayEffort || "";
}

// URLパラメータで自動設定
(function autoSetup() {
  const p = new URLSearchParams(location.search);
  if (p.get("token")) {
    saveSettings({ url: p.get("url") || location.origin, token: p.get("token") });
    history.replaceState({}, "", location.pathname);
  }
  // register_token は Passkey 登録フローへ。
  // 取得後すぐに全画面モーダル（passkey-autostart）を出すマーキングをする。
  if (p.get("register_token")) {
    sessionStorage.setItem("pendingRegisterToken", p.get("register_token"));
    sessionStorage.setItem("autoStartPasskey", "1");
    if (!localStorage.getItem("agentUrl")) {
      saveSettings({ url: location.origin });
    }
    history.replaceState({}, "", location.pathname);
  }
})();

// ===== API =====
function authHeader() {
  const s = getSettings();
  const jwt = localStorage.getItem("passkeyJwt");
  // JWT 優先（有効期限内なら）→ なければ AGENT_TOKEN
  if (jwt) {
    if (jwtValid(jwt)) return "Bearer " + jwt;
    // 期限切れ JWT は捨てる。残しておくと fallback で謎の 401 が出続ける
    localStorage.removeItem("passkeyJwt");
  }
  return "Bearer " + s.token;
}
// JWT payload は base64url。atob 直呼びは '-'/'_' 混入で throw（＝有効な JWT を
// 期限切れ扱いで捨てて再ログイン強制）し、日本語端末名は Latin-1 化けする。
// b64uToArr + TextDecoder で正しく復号する。
function jwtPayload(jwt) {
  return JSON.parse(new TextDecoder().decode(b64uToArr(jwt.split(".")[1])));
}
function jwtValid(jwt) {
  try {
    const payload = jwtPayload(jwt);
    return (payload.exp || 0) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
// このページが PC ローカル（管理用）として開かれているか。127.0.0.1 / localhost のみ真。
// 端末追加トークンの発行などローカル特権が要る操作は、ここが真のときだけ UI に出す
// （公開URLで出すと必ずサーバ側 403 になり、混乱の元になるため）。
function isLocalOrigin() {
  const h = location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}
// 一過性の通信失敗（モバイル回線の瞬断・CFエッジ瞬断・watchdog経由でのagent再起動中
// の 5xx）は、ジョブストリームの reconnect と同じ思想で数回リトライしてから諦める。
// スマホは Wi-Fi↔モバイル切替やトンネル瞬断で fetch が一瞬だけ落ちることが多く、
// 1回失敗で即赤エラー（「PCのエージェントが停止しています」等）を出していたのが
// 「ときどきランダムに勝手にエラーが出る」の正体。瞬断はユーザーに見せず、本当に
// 落ちている時（リトライしても回復しない時）だけ表示する。
const API_RETRY = 3;          // 初回 + リトライ込みの総試行回数
const API_RETRY_DELAY = 500;  // ms（試行ごとに線形に伸ばす）
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _healthTimerStarted = false;   // checkHealth の 60s ポーリングを二重に張らないためのガード

async function api(path, method = "GET", body = null, signal = null) {
  const { url } = getSettings();
  const base = url || location.origin;
  let lastErr = null;
  for (let attempt = 0; attempt < API_RETRY; attempt++) {
    const isLast = attempt === API_RETRY - 1;
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", "Authorization": authHeader() },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch(e) {
      if (e.name === "AbortError") throw e;
      lastErr = new Error(t("err.network"));
      if (isLast) throw lastErr;
      await _sleep(API_RETRY_DELAY * (attempt + 1));
      continue;  // 瞬断 → リトライ
    }
    // 一過性 5xx（agent 再起動中・watchdog の 503・CF エッジ 52x）は本文を読まずリトライ。
    // これらは「リクエストが処理に届かなかった」系なので、POST でも重複の心配は小さい。
    const transient = res.status === 502 || res.status === 503 || res.status === 504
                      || (res.status >= 520 && res.status <= 530);
    if (transient && !isLast) {
      await _sleep(API_RETRY_DELAY * (attempt + 1));
      continue;
    }
    try {
      return await _handleApiResponse(res);
    } catch (e) {
      // セッション中に JWT が切れて 401 になったら、滑らかに再ログインへ。
      // /auth/* 自体の 401（ログイン失敗など）はモーダルを出すと無限ループになるので除外。
      if (res.status === 401 && !path.startsWith("/auth/") && typeof showLoginModal === "function") {
        showLoginModal();
      }
      throw e;
    }
  }
  throw lastErr || new Error(t("err.commFailed"));  // 到達しない保険
}

async function _handleApiResponse(res) {
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) {
      let needPasskey = false;
      try { needPasskey = JSON.parse(text).need_passkey === true; } catch {}
      if (needPasskey) {
        localStorage.removeItem("passkeyJwt");
        throw new Error(t("err.needPasskey"));
      }
      // 期限切れ JWT を握ってた場合は捨てる
      localStorage.removeItem("passkeyJwt");
      throw new Error(t("err.auth401"));
    }
    if (res.status === 404) throw new Error(t("err.url404"));
    if (res.status === 429) throw new Error(t("err.tooMany"));
    if (res.status >= 520 && res.status <= 530) throw new Error(t("err.agentDown"));
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error(t("err.agentDown"));
    throw new Error(t("err.generic", {status: res.status, text: text.slice(0, 100)}));
  }
  return res.json();
}

// ===== 状態管理 =====
let projects = [];
let selectedProject = null;
// activeJobs: 並列実行中のジョブを id → AbortController で管理
const activeJobs = new Map();
// jobInfo: 並列ジョブの付帯情報 id → { projectId, projectName }。
// 別プロジェクトのジョブを「裏で」走らせる時、その出力を今見ている画面に
// 混ぜないため／プロジェクト切替時にどのジョブが裏で動いているか判定するため。
const jobInfo = new Map();
// 今表示中のプロジェクトのジョブだけが $messages に描画してよい。
function isJobVisible(projectId) {
  return (selectedProject?.id || "default") === (projectId || "default");
}
// 裏で走っているジョブ件数（今見ているプロジェクト以外）。
function backgroundJobCount() {
  let n = 0;
  for (const info of jobInfo.values()) if (!isJobVisible(info.projectId)) n++;
  return n;
}
const ADHOC_KEY = Symbol("adhoc");   // 📋状況/📅まとめ等の非ジョブ系処理用キー
let lastJobId = null;                // 中断ボタンと再接続が対象にする最新ジョブ
let _loadingCount = 0;
let _interrupting = false;   // ⚡割り込み中フラグ（中断メッセージの二重表示を抑制）
let isPaused = false;
let currentAbortController = null;
// 実行中に追加送信された指示の待ち行列。現ジョブ完了後に同じセッションで続けて実行する。
let pendingQueue = [];
// 起動処理中（jobs API のレスポンス待ち）のプロジェクト。連打で2発が同時に
// 「実行中ジョブなし」判定をすり抜けて並列起動するレースを同期的に塞ぐ。
const startingProjects = new Set();

// ===== DOM =====
const $main        = document.getElementById("mainScreen");
const $messages    = document.getElementById("messages");
const $instruction = document.getElementById("instruction");
const $sendBtn     = document.getElementById("sendBtn");
const $micBtn      = document.getElementById("micBtn");
const $statusDot   = document.getElementById("statusDot");
const $statusText  = document.getElementById("statusText");
const $projSelect  = document.getElementById("projectSelect");

// ===== 自動スクロール追従 =====
// 最下部付近にいる時だけ新着で下に追従する。ユーザーが上を見ている（上にスクロールした）
// 間は勝手に下げない。下に戻れば再び追従が復活する。標準的なチャットの挙動。
let _stick = true;   // 追従ON＝最下部に貼り付く
const $jumpBottom = document.getElementById("jumpBottom");
function atBottom() {
  // ピッタリ最下部でなくても、しきい値（120px）以内なら「下にいる」扱い。
  return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 120;
}
// 追従できない（＝ユーザーが上を見ている）間だけ「↓最新へ」ボタンを出す。
// 最下部にいる時は隠す。新着が来た時は pulse で気付けるようにする。
function syncJumpBtn(pulse) {
  if (!$jumpBottom) return;
  const show = !_stick;
  $jumpBottom.classList.toggle("visible", show);
  if (show && pulse) {
    $jumpBottom.classList.add("pulse");
  } else if (!show) {
    $jumpBottom.classList.remove("pulse");
  }
}
function stickToBottom() {
  if (_stick) { $messages.scrollTop = $messages.scrollHeight; syncJumpBtn(false); }
  else syncJumpBtn(true);   // 下げられない＝新着が裏に積まれた → ボタンを点滅で知らせる
}
$messages.addEventListener("scroll", () => { _stick = atBottom(); syncJumpBtn(false); }, { passive: true });
$jumpBottom?.addEventListener("click", () => {
  _stick = true; $messages.scrollTop = $messages.scrollHeight; syncJumpBtn(false);
});

// ===== 画面表示 =====
// パスキー専用なので「トークン貼付の設定画面」は廃止。表示はメイン1枚＋必要時オーバーレイ。
function showMain() { $main.style.display = "flex"; }

// ===== ヘルスチェック =====
// /health の fetch が一瞬落ちただけで「切断」に倒すと、ステータスドットが
// チカチカし、送信前チェックも無駄に弾く。瞬断を吸収するため軽くリトライする。
async function _fetchHealth() {
  const { url } = getSettings();
  const base = (url || location.origin).replace(/\/+$/, "");
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // AbortSignal.timeout は iOS16+ のみ（iOS15 等には無い）→ AbortController で代替
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(base + "/health", { signal: ctl.signal });
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await _sleep(600);  // 1回だけ間を置いて再試行
    } finally {
      clearTimeout(tm);
    }
  }
  throw lastErr;
}

async function checkHealth() {
  try {
    const d = await _fetchHealth();
    if (d.agent === "down") {
      $statusDot.className = "status-dot";
      $statusDot.style.background = "var(--yellow)";
      $statusText.textContent = t("status.agentDown");
      isPaused = false; return "watchdog";
    }
    isPaused = !!d.paused;
    $statusDot.className = isPaused ? "status-dot" : "status-dot on";
    $statusDot.style.background = isPaused ? "var(--yellow)" : "";
    $statusText.textContent = (d.pc || "") + " " + (isPaused ? t("status.paused") : t("status.running"));
    return true;
  } catch {
    $statusDot.className = "status-dot off";
    $statusDot.style.background = "";
    $statusText.textContent = t("status.disconnected");
    return false;
  }
}

// ===== IDE プロジェクトピッカー =====
const IDE_INFO = {
  vscode:   { name: "VS Code",     buildUrl: (s, p) => `https://vscode.dev/tunnel/${s.vscodeName}` + (p ? "/" + p : "") },
};
let _activeIde = null;

function openIdePicker(ide) {
  _activeIde = ide;
  document.getElementById("idePickerTitle").textContent = t("ide.openTitle", {name: IDE_INFO[ide].name});
  const $list = document.getElementById("idePickerList");
  if (!projects.length) {
    $list.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">${t("list.noProjects")}</div>`;
  } else {
    $list.innerHTML = projects.map(p => `
      <button class="ide-project-item" data-id="${escapeHtml(p.id)}" data-path="${escapeHtml(p.path)}" data-name="${escapeHtml(p.name)}">
        <span class="ide-project-name">${escapeHtml(p.name)}</span>
        <span class="ide-project-path">${escapeHtml(p.path)}</span>
      </button>`).join("");
  }
  document.getElementById("idePickerDrawer").classList.add("open");
  document.getElementById("idePickerOverlay").classList.add("open");
}
function closeIdePicker() {
  document.getElementById("idePickerDrawer").classList.remove("open");
  document.getElementById("idePickerOverlay").classList.remove("open");
}

// VS Code ボタンは git バーに移動（Pull の左）。タップでプロジェクトピッカー。
document.getElementById("vscodeBtn").onclick = () => openIdePicker("vscode");
document.getElementById("idePickerClose").onclick    = closeIdePicker;
document.getElementById("idePickerOverlay").onclick  = closeIdePicker;
document.getElementById("idePickerList").addEventListener("click", e => {
  const btn = e.target.closest(".ide-project-item");
  if (!btn) return;
  const proj = { id: btn.dataset.id, path: btn.dataset.path, name: btn.dataset.name };
  selectedProject = proj;
  $projSelect.value = proj.id;
  localStorage.setItem("selectedProjectId", proj.id);
  const s = getSettings();
  const url = IDE_INFO[_activeIde].buildUrl(s, proj.path.replace(/\\/g, "/"));
  window.open(url, "_blank");
  loadConversation();
  closeIdePicker();
  showToast(t("ide.opened", {proj: proj.name, ide: IDE_INFO[_activeIde].name}));
});

// ===== プロジェクト =====
async function loadProjects() {
  try {
    projects = await api("/projects/");
    $projSelect.innerHTML = `<option value="">${t("proj.select")}</option>` +
      projects.map(p => `<option value="${p.id}" data-path="${escapeHtml(p.path)}">${escapeHtml(p.name)}</option>`).join("");
    if (projects.length > 0) {
      // 前回選択を復元。なければ先頭。
      const savedId = localStorage.getItem("selectedProjectId");
      const found = savedId && projects.find(p => p.id === savedId);
      selectedProject = found || projects[0];
      $projSelect.value = selectedProject.id;
    }
    renderWelcome();
  } catch(e) { addMsg("error", e.message); }
}

$projSelect.onchange = () => {
  const opt = $projSelect.selectedOptions[0];
  selectedProject = opt.value ? { id: opt.value, path: opt.dataset.path, name: opt.text } : null;
  if (selectedProject) localStorage.setItem("selectedProjectId", selectedProject.id);
  else localStorage.removeItem("selectedProjectId");
  loadConversation();
  updatePills();
};

// ===== ウェルカム画面 =====
function renderWelcome() {
  if ($messages.children.length > 0) return;
  const w = document.createElement("div");
  w.id = "welcomeScreen";
  w.innerHTML = `
    <div class="welcome-icon">🤖</div>
    <div class="welcome-title">${t("welcome.title")}</div>
    <div class="welcome-desc">${t("welcome.desc")}</div>
    <div class="welcome-hints">
      <div class="welcome-hint"><span class="welcome-hint-icon">⬡</span><span>${t("welcome.hint1")}</span></div>
      <div class="welcome-hint"><span class="welcome-hint-icon">↓</span><span>${t("welcome.hint2")}</span></div>
      <div class="welcome-hint"><span class="welcome-hint-icon">⭐</span><span>${t("welcome.hint3")}</span></div>
      <div class="welcome-hint"><span class="welcome-hint-icon">🕘</span><span>${t("welcome.hint4")}</span></div>
    </div>
    <button onclick="document.getElementById('helpBtn').click()" style="background:none;border:1px solid var(--border);border-radius:20px;padding:8px 18px;font-size:13px;color:var(--accent);cursor:pointer;">${t("welcome.seeAll")}</button>`;
  $messages.appendChild(w);
}
function removeWelcome() {
  document.getElementById("welcomeScreen")?.remove();
}

// ===== Markdown =====
function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  try {
    const rawHtml = marked.parse(text, { breaks: true, gfm: true });
    // DOMPurify でサニタイズ（XSS対策: <script>, on* 属性, javascript: URL を除去）
    const safe = (typeof DOMPurify !== "undefined")
      ? DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } })
      : escapeHtml(text);
    const wrap = document.createElement("div");
    wrap.innerHTML = safe;
    wrap.querySelectorAll("pre code").forEach(el => { if (typeof hljs !== "undefined") hljs.highlightElement(el); });
    return wrap.innerHTML;
  } catch { return escapeHtml(text); }
}

// 本文中の選択肢マーカー [[choice:質問|A|B|C]] を取り出す。
// 返り値 { clean: マーカーを除いた本文, choices: [{question, options[]}] }。
// 金庫の [[secret:...]] と同型で、CLI には触らず UI だけで往復を作る仕組み。
function extractChoices(text) {
  const choices = [];
  const clean = String(text || "").replace(/\[\[choice:([^\]]*)\]\]/g, (_, body) => {
    const parts = body.split("|").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      choices.push({ question: parts[0], options: parts.slice(1) });
    }
    return "";  // 本文からは除去（ボタンで代替表示する）
  }).trim();
  return { clean, choices };
}

// 選択肢タップ→その答えを次の指示として送る（send() が $instruction を読む）。
function submitChoice(answer) {
  if (typeof send !== "function") return;
  $instruction.value = answer;
  $instruction.style.height = "auto";
  send();
}

// ===== AI メッセージ要素 =====
function buildAiMsgEl(text, actions, summary) {
  const d = document.createElement("div");
  d.className = "msg msg-ai";
  const { clean, choices } = extractChoices(text);
  const textEl = document.createElement("div");
  textEl.innerHTML = renderMarkdown(clean);
  d.appendChild(textEl);
  // 選択肢マーカーがあればボタン群を描画。タップで答えを次の指示として送る。
  for (const ch of choices) {
    const box = document.createElement("div");
    box.className = "choice-box";
    if (ch.question) {
      const q = document.createElement("div");
      q.className = "choice-q";
      q.textContent = ch.question;
      box.appendChild(q);
    }
    const row = document.createElement("div");
    row.className = "choice-row";
    for (const opt of ch.options) {
      const b = document.createElement("button");
      b.className = "choice-btn";
      b.textContent = opt;
      // onclick は生成直後しか効かない（リロードで innerHTML 復元されると失われる）。
      // 実際のクリックは $messages の委譲ハンドラが dataset.answer から拾う。
      b.dataset.answer = opt;
      row.appendChild(b);
    }
    box.appendChild(row);
    d.appendChild(box);
  }
  // コードブロックごとに右上へ📋を差す。pre 内の <code> 全文をコピー（行番号や装飾は含まない）。
  textEl.querySelectorAll("pre").forEach(pre => {
    const codeEl = pre.querySelector("code");
    if (!codeEl) return;
    const cb = document.createElement("button");
    cb.className = "code-copy-btn"; cb.textContent = "📋"; cb.title = t("copy.code");
    // クリックは $messages の委譲ハンドラが拾う（リロード後も効くように）。
    pre.appendChild(cb);
  });
  // 要約ボックス（「💡 つまり:」）は本文の繰り返しで冗長なので表示しない。
  // 引数 summary は通知タイトル等で別途使うため残す。
  if (actions && actions.length > 0) {
    const actDiv = document.createElement("div");
    actDiv.style.cssText = "margin-top:8px;padding:8px;background:rgba(0,0,0,0.3);border-radius:8px;border-left:3px solid var(--muted);";
    const btn = document.createElement("button");
    btn.style.cssText = "background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;padding:0;text-decoration:underline;";
    btn.textContent = t("details.show", {n: actions.length});
    const logDiv = document.createElement("div");
    logDiv.style.cssText = "display:none;margin-top:8px;font-size:11px;color:var(--muted);font-family:monospace;line-height:1.6;max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.5);padding:8px;border-radius:6px;";
    logDiv.innerHTML = actions.map(a => `<div>→ ${escapeHtml(String(a))}</div>`).join("");
    btn.onclick = () => {
      const vis = logDiv.style.display === "none";
      logDiv.style.display = vis ? "block" : "none";
      btn.textContent = vis ? t("details.hide") : t("details.show", {n: actions.length});
    };
    actDiv.appendChild(btn); actDiv.appendChild(logDiv); d.appendChild(actDiv);
  }
  // 返答下部のアクション行: 🔊読み上げ / 📋全文コピー。長押しコピーは気付きにくいので明示ボタンも置く。
  const actions2 = document.createElement("div");
  actions2.className = "msg-actions";
  const ttsBtn = document.createElement("button");
  ttsBtn.className = "tts-btn"; ttsBtn.textContent = "🔊"; ttsBtn.title = t("tts.title");
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn"; copyBtn.textContent = "📋"; copyBtn.title = t("copy.title");
  // クリックは $messages の委譲ハンドラが拾う（dataset.rawText から本文を取る）。
  // リロード後（innerHTML 復元で onclick が消える）でも効くようにするため。
  actions2.appendChild(ttsBtn); actions2.appendChild(copyBtn);
  d.appendChild(actions2);
  d.dataset.rawText = text;
  return d;
}

// クリップボードへコピーし、押したボタンを一時的に✓へ。トーストも出す（モバイルで反応が分かりやすい）。
function copyText(str, btn) {
  navigator.clipboard?.writeText(str).then(() => {
    showToast(t("toast.copied"));
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "✓"; btn.classList.add("copied");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
    }
  });
}

// ===== メッセージ追加 =====
function addMsg(type, text, actions = [], summary = "") {
  removeWelcome();
  let d;
  if (type === "ai") {
    d = buildAiMsgEl(text, actions, summary);
  } else {
    d = document.createElement("div");
    d.className = type === "user" ? "msg msg-user" : type === "error" ? "msg msg-error" : "msg msg-system";
    d.textContent = text;
    // 自分の書き込み（user）にも📋全文コピーを付ける。長押しは気付きにくいので明示ボタンを置く。
    // rawText を data 属性に持たせ、リロード後（innerHTML 復元で onclick が失われる）でも
    // 委譲ハンドラがここからコピーできるようにする。
    if (type === "user") {
      d.dataset.rawText = text;
      const acts = document.createElement("div");
      acts.className = "msg-actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn"; copyBtn.textContent = "📋"; copyBtn.title = t("copy.title");
      acts.appendChild(copyBtn);
      d.appendChild(acts);
    }
  }
  $messages.appendChild(d);
  // 自分の送信でも勝手に最下部へ飛ばさない。上を読んでいる間は位置を保つ。
  // 最下部付近にいる時だけ stickToBottom が追従する（_stick は scroll で更新済み）。
  stickToBottom();
  saveConversation();
  return d;
}

// ===== ローディング =====
// 並列実行を許可するため、in-flight 数のカウンタで判定する。
// 送信ボタンは常に押せる（前のジョブが走ってても新しい指示を投げられる）。
function setLoading(on) {
  if (on) _loadingCount++;
  else _loadingCount = Math.max(0, _loadingCount - 1);
  const loading = _loadingCount > 0;
  $sendBtn.disabled = false;
  $sendBtn.style.display = "flex";
  const $cancel = document.getElementById("cancelBtn");
  if (loading) $cancel.classList.add("visible"); else $cancel.classList.remove("visible");
  const $interrupt = document.getElementById("interruptBtn");
  if ($interrupt) { if (loading) $interrupt.classList.add("visible"); else $interrupt.classList.remove("visible"); }
  $sendBtn.title = loading ? t("tip.sendQueue") : t("tip.send");
  document.getElementById("typingDot")?.remove();
  if (loading) {
    const d = document.createElement("div");
    d.id = "typingDot"; d.className = "typing-indicator";
    d.innerHTML = "<span></span><span></span><span></span>";
    $messages.appendChild(d); stickToBottom();
  } else {
    // アイドルに戻ったら、待ち行列の追加指示を続けて実行する
    maybeRunNext();
  }
}

// ===== ジョブ実行（jobs API + SSE、再接続可能、並列実行可） =====

async function send() {
  const text = $instruction.value.trim();
  if (!text && !attachedFiles.length) return;
  // 🔒金庫A方向の事前ガード: ロック中に {{名前}} を送ると黙って値なし送信になる事故を
  // ここで止める（詳細は vaultGuardBlocks）。止めた時は入力欄を消さない＝開錠後そのまま自動送信。
  if (vaultGuardBlocks(text, "send")) return;
  // 🔒値の確保はガード直後（await の前）に行う。添付アップロード等で時間が経つと
  // 自動ロックで金庫が閉じ、値なし送信に化けるため（添付の追記行に {{名前}} は入らない）。
  const vaultSecretsForSend = vaultCollectSecretsFor(text);
  if (vaultSecretsForSend) vaultLock();  // 送信したら即再ロック（不変条件4）
  // 送信先は「送信ボタンを押した瞬間のプロジェクト」に固定する。以降 await（health/
  // アップロード/jobs API）の間にユーザーが画面を切り替えても、この最初の値を使う。
  // これを掴まないと、投稿直後に別プロジェクトへ移動した時に送信先が引きずられる。
  const sendProject = selectedProject;
  pulseSendBtn();   // 押した合図のポップ（中身がある時だけ＝空打ちでは光らせない）
  const health = await checkHealth();
  if (health === "watchdog") {
    addMsg("error", t("agentStopped.send"));
    return;
  }
  pushHistory(text);
  // 添付ファイルがあれば先にアップロード → 指示にパスを埋め込む
  let finalText = text;
  if (attachedFiles.length) {
    addMsg("system", t("attach.uploading", {n: attachedFiles.length}));
    try {
      const uploaded = await uploadAttached();
      const lines = uploaded.map(u => `- ${u.filename} → ${u.path}`).join("\n");
      finalText = `${text || t("attach.confirm")}\n\n${t("attach.label")}:\n${lines}`;
    } catch (e) {
      addMsg("error", t("attach.uploadFail", {msg: e.message}));
      return;
    } finally {
      clearAttachments();
    }
  }
  addMsg("user", finalText);
  $instruction.value = ""; $instruction.style.height = "auto";
  clearDraft();   // 送信できたので、このプロジェクトの書きかけは消す
  syncAppHeight();

  // 同時進行ポリシー:
  //  ・「今見ているプロジェクト」に既に実行中ジョブがある → 待ち行列（同じ会話を継ぐため）
  //  ・別プロジェクトで実行中でも、今のプロジェクトが空いていれば → そのまま並列で開始
  // ＝プロジェクトをまたいだ依頼は同時進行できる。同じプロジェクト内の2発目だけ順番待ち。
  const projKey = sendProject?.id || "default";
  const sameProjectRunning = startingProjects.has(projKey) || [...jobInfo.values()].some(
    info => (info.projectId || "default") === projKey
  );
  if (sameProjectRunning) {
    pendingQueue.push({ text: finalText, secrets: vaultSecretsForSend, projectId: projKey });
    const waiting = pendingQueue.filter(q => (q.projectId || "default") === projKey).length;
    addMsg("system", t("queue.added", {n: waiting}));
    return;
  }
  await runJob(finalText, vaultSecretsForSend, projKey);
}

// 待ち行列に積まれた追加指示を、そのプロジェクトの実行中ジョブが無くなったら順に実行する。
// 各プロジェクト独立: あるプロジェクトのジョブ完了は、そのプロジェクトの待ち行列だけを進める。
function maybeRunNext() {
  if (!pendingQueue.length) return;
  // 実行中でないプロジェクトの待ち項目を先頭から探して動かす。
  const runningProjects = new Set(
    [...jobInfo.values()].map(info => info.projectId || "default")
  );
  const idx = pendingQueue.findIndex(q => {
    const pid = (typeof q === "string" ? projKeyHint : q.projectId) || "default";
    return !runningProjects.has(pid);
  });
  if (idx < 0) return;
  const next = pendingQueue.splice(idx, 1)[0];
  // 旧形式（文字列）と新形式（{text, secrets, projectId}）の両対応
  if (typeof next === "string") runJob(next);
  else runJob(next.text, next.secrets, next.projectId);
}
// 旧形式の文字列キュー項目用フォールバック（projectId 不明 → 現在のプロジェクト扱い）
let projKeyHint = "default";

// ⚡ 今すぐ割り込み: 実行中の生成を止めて、新しい指示で即立て直す。
// 会話(セッション)は切らない＝ new_session:false の resume なので文脈は保持される。
// 既存の待ち行列はクリアせず、この指示を先頭に差し込んで最優先で実行する。
async function interruptSend() {
  const text = $instruction.value.trim();
  if (!text && !attachedFiles.length) { showToast(t("toast.typeFirst")); return; }
  // 実行中でなければ通常送信と同じ
  if (_loadingCount === 0 && activeJobs.size === 0) { return send(); }
  // 🔒金庫A方向: 割り込みも send() と同じガード＋値の確保を通す
  // （旧実装は secrets:null 固定＝割り込みだけ値が届かない穴だった）。
  if (vaultGuardBlocks(text, "interrupt")) return;
  const vaultSecretsForSend = vaultCollectSecretsFor(text);
  if (vaultSecretsForSend) vaultLock();
  pulseSendBtn();
  pushHistory(text);
  const finalText = text;   // 割り込みはテキスト指示のみ（添付は通常送信で）
  addMsg("user", finalText);
  $instruction.value = ""; $instruction.style.height = "auto";
  clearDraft(); syncAppHeight();   // 送信できたので書きかけは消す
  addMsg("system", t("interrupt.switching"));
  // 新形式で積む（文字列で積むと projectId 不明＝"default" 扱いになり、
  // 別プロジェクトを見ている間に走ると指示がそちらへ飛ぶ）
  pendingQueue.unshift({ text: finalText, secrets: vaultSecretsForSend, projectId: selectedProject?.id || "default" });   // 先頭に差し込む＝中断後に必ずこれが走る
  _interrupting = true;
  const ids = [...activeJobs.keys()];
  for (const jobId of ids) {
    try { await api(`/jobs/${jobId}/cancel`, "POST"); } catch {}
    const ab = activeJobs.get(jobId);
    if (ab) ab.abort();
  }
  // 中断 → streamJob 終了 → finish() → setLoading(false) → maybeRunNext() が
  //   先頭(=この指示)を runJob（resume＝文脈保持）で実行する。
}
document.getElementById("interruptBtn").onclick = interruptSend;

async function runJob(instruction, secrets, projectId) {
  // 同時進行: ジョブは「投入時点のプロジェクト」に固定する。待ち行列から遅れて走る
  // 別プロジェクトの項目でも、selectedProject（今見ている画面）に引きずられない。
  const targetProject = projectId
    ? (projects.find(p => p.id === projectId) || selectedProject)
    : selectedProject;
  const projKey = targetProject?.id || "default";

  // jobs API のレスポンスが返るまでこのプロジェクトを「起動中」に固定。
  // この間に来た同プロジェクトの送信は send() 側で待ち行列に回り、並列起動しない。
  startingProjects.add(projKey);
  setLoading(true);
  _interrupting = false;   // 新ジョブ開始＝割り込み処理は完了
  document.getElementById("typingDot")?.remove();
  const abort = new AbortController();

  const s = getSettings();
  const base = (s.url || location.origin).replace(/\/+$/, "");
  const startNew = sessionStorage.getItem("forceNewConv_" + projKey) === "1";
  sessionStorage.removeItem("forceNewConv_" + projKey);

  const payload = {
    engine: "claude_code",
    instruction,
    project_path: targetProject?.path || null,
    new_session: startNew,
    permission_mode: s.permMode,
  };
  // モデル/effort/thinking はプロジェクト別上書き（あれば）→共通設定の順で決める。
  const eff = effectiveJobSettings(targetProject?.id);
  if (eff.model) payload.model = eff.model;
  if (eff.effort) payload.effort = eff.effort;
  // 拡張思考。既定オンなので off の時だけ明示送信（サーバ既定 True）。
  if (eff.thinking === "off") payload.thinking = false;
  // 🔒金庫A方向: 該当する {{名前}} の実値だけを secrets として送る。
  // サーバは job/events/ログには入れず、一時ファイル書込み直前にだけ注入する。
  if (secrets) payload.secrets = secrets;

  let job;
  try {
    job = await api("/jobs/", "POST", payload);
  } catch (e) {
    addMsg("error", e.message);
    startingProjects.delete(projKey);
    setLoading(false);
    return;
  }
  lastJobId = job.id;
  activeJobs.set(job.id, abort);
  jobInfo.set(job.id, { projectId: projKey, projectName: targetProject?.name || "" });
  // jobInfo に乗った＝以後は「実行中」判定で捕まる。起動中フラグは役目終了。
  startingProjects.delete(projKey);
  // 別プロジェクトを裏で開始したと分かるよう、今の画面に一行知らせる。
  if (!isJobVisible(projKey)) {
    addMsg("system", t("bg.started", { project: targetProject?.name || projKey }));
    updateBgBadge();
  }
  localStorage.setItem("lastJobId_" + projKey, job.id);

  await streamJob(job.id, /* fromSeq */ 0, abort);
}

// 画面が途中で閉じた/リロードされた後の自動復帰。PC 側ではジョブが走り続けているので、
// 開いているプロジェクトの「走行中ジョブ」をサーバから拾って streamJob に繋ぎ直す。
// from_seq=0 でイベントをリプレイするので、途中経過も結果も取りこぼさない。
// これが無いと会話本文だけ復元され、走行中の続きは📋を手で開くまで出なかった。
async function reattachRunningJobs() {
  const proj = selectedProject;
  if (!proj) return;
  try {
    const list = await api(`/jobs/?project_path=${encodeURIComponent(proj.path)}`);
    const running = (list || []).filter(j => j.status === "running" && !activeJobs.has(j.id));
    for (const j of running) {
      jobInfo.set(j.id, { projectId: proj.id, projectName: proj.name || "" });
      const abort = new AbortController();
      activeJobs.set(j.id, abort);
      lastJobId = j.id;
      setLoading(true);
      addMsg("system", t("job.reconnect", { id: j.id }));
      streamJob(j.id, 0, abort);   // await しない: 複数走行中でも並行に拾う
    }
    updateBgBadge();
  } catch {}
}

async function streamJob(jobId, fromSeq, abort, attempt = 0) {
  // 並列実行対応: abort は呼び出し側から渡されるのが基本。
  // 未指定なら新規に作成して登録（再接続用パスのフォールバック）。
  if (!abort) {
    abort = new AbortController();
    activeJobs.set(jobId, abort);
  }
  // このジョブが属するプロジェクト。今見ている画面と一致する時だけ $messages に描画する。
  // 一致しない（裏で実行中）なら DOM には触れず、完了時にそのプロジェクトの会話へ保存する。
  const thisProjectId = jobInfo.get(jobId)?.projectId || (selectedProject?.id || "default");
  const thisProjectName = jobInfo.get(jobId)?.projectName || "";
  const vis = () => isJobVisible(thisProjectId);   // 動的: 途中でプロジェクトを切り替えても追従
  const s = getSettings();
  const base = (s.url || location.origin).replace(/\/+$/, "");
  const aiDiv = document.createElement("div");
  aiDiv.className = "msg msg-ai";
  // jobInfo にライブ要素を結びつけておく。プロジェクトを切り替えてこのジョブが
  // 「見える側」になった時、switchProject 経由で aiDiv を $messages に挿し込める。
  const inf = jobInfo.get(jobId);
  if (inf) inf.aiDiv = aiDiv;
  if (vis()) $messages.appendChild(aiDiv);

  let rawText = "";
  const actions = [];
  const toolResults = [];
  let shownActualModel = false;  // 実モデル行は1ジョブ1回だけ表示
  let doneData = null;
  let lastSeq = fromSeq - 1;  // 切れた時の再接続用
  let gotAny = false;         // この接続で1件でも受信できたか（できたら attempt をリセット）
  let settled = false;        // 終端処理済みフラグ（finally の二重後始末防止）

  // ライブステータス（実行中バッジ）: 沈黙時間中も「動いてる」を可視化。
  // 跳ねるドット + 経過秒 + 直近アクション。aiDiv の末尾に常駐させ、rerender 時に再付与。
  const liveStartedAt = Date.now();
  let liveLabel = "考え中…";
  const liveStatus = document.createElement("div");
  liveStatus.className = "live-status";
  liveStatus.innerHTML =
    '<span class="live-dots"><span></span><span></span><span></span></span>' +
    '<span class="live-label"></span>' +
    '<span class="live-elapsed">0s</span>';
  const $liveLabel = liveStatus.querySelector(".live-label");
  const $liveElapsed = liveStatus.querySelector(".live-elapsed");
  function fmtElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), r = sec % 60;
    return m + "m" + r.toString().padStart(2, "0") + "s";
  }
  function setLiveLabel(txt) { liveLabel = txt; $liveLabel.textContent = txt; }
  setLiveLabel(liveLabel);
  const liveTimer = setInterval(() => {
    $liveElapsed.textContent = fmtElapsed(Date.now() - liveStartedAt);
  }, 1000);
  // 初回は空の aiDiv に直接付ける（rerender が呼ばれるまで待たない）
  aiDiv.appendChild(liveStatus);
  if (vis()) stickToBottom();

  function finish() {
    if (settled) return;
    settled = true;
    clearInterval(liveTimer);
    activeJobs.delete(jobId);
    jobInfo.delete(jobId);
    updateBgBadge();
    setConnBar(null);   // 再接続帯が残っていたら必ず消す
    setLoading(false);  // ← 0 に戻ると待ち行列の続きを自動実行（maybeRunNext）
  }

  // 接続が切れた時の自動再接続。スマホはバックグラウンド化・Wi-Fi↔モバイル回線
  // 切替・トンネル瞬断で fetch が頻繁に切れる。ジョブは PC 側で走り続けているので
  // from_seq から取り直せば取りこぼしなく再開できる（指数バックオフ）。
  // 1件でも受信できていれば attempt をリセットし、長時間ジョブでも粘る。
  const MAX_ATTEMPTS = 14;
  async function reconnect(reason) {
    aiDiv.remove();
    // この呼び出しの liveTimer は使い終わり。次の streamJob が自分の分を立てる。
    // (下で settled=true 後に finish() が呼ばれても早期 return するので明示的に掃除)
    clearInterval(liveTimer);
    if (abort.signal.aborted) { finish(); return; }
    const nextAttempt = gotAny ? 0 : attempt + 1;
    if (nextAttempt > MAX_ATTEMPTS) {
      if (vis()) { setConnBar(null); addMsg("error", t("conn.notRecovered")); }
      else addMsg("system", t("bg.error", { project: thisProjectName || thisProjectId, summary: t("conn.notRecovered") }));
      finish();
      return;
    }
    const delay = Math.min(800 * Math.pow(1.7, nextAttempt), 12000);
    // 通知は fixed の帯（#connBar）だけに出す。#messages に積むと最後の行として
    // 入力欄の上に居座り、画面が短い時にツールバーを押し出す原因になっていた。
    // 裏で走っているジョブの再接続帯は出さない（今見ているプロジェクトの邪魔になるため）。
    if (vis()) setConnBar(t("status.reconnecting"), false);
    await new Promise(r => setTimeout(r, delay));
    settled = true;  // この呼び出しの後始末は次の streamJob に委譲
    return streamJob(jobId, lastSeq + 1, abort, nextAttempt);
  }

  function rerender() {
    aiDiv.innerHTML = "";
    if (actions.length) {
      const p = document.createElement("div");
      p.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:6px;font-family:monospace;";
      p.textContent = "⚙ " + actions[actions.length - 1];
      aiDiv.appendChild(p);
    }
    if (rawText) {
      const t = document.createElement("div");
      t.innerHTML = renderMarkdown(rawText); aiDiv.appendChild(t);
    }
    // ライブステータスは常に末尾に
    aiDiv.appendChild(liveStatus);
    if (vis()) stickToBottom();
  }

  try {
    const res = await fetch(`${base}/jobs/${jobId}/stream?from_seq=${fromSeq||0}`, {
      headers: { "Authorization": authHeader() },
      signal: abort.signal,
    });
    if (!res.ok) {
      // 認証・不存在は再接続しても無駄 → そのまま終了
      if ([401, 403, 404].includes(res.status)) {
        aiDiv.remove();
        addMsg("error", res.status === 401
          ? "認証エラー（401）。設定 → 🔓 Passkey でログインし直してください"
          : `ジョブ接続失敗 ${res.status}`);
        finish(); return;
      }
      // 5xx 等（エージェント再起動中・エッジ瞬断）は再接続
      return await reconnect(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch { continue; }
        if (!gotAny) setConnBar(null);   // 復帰したら再接続帯を消す
        gotAny = true;
        if (typeof d._seq === "number" && d._seq > lastSeq) lastSeq = d._seq;
        if (d.type === "ping") continue;
        if (d.type === "started") {
          actions.push(t("model.started", {model: d.model || "Claude Code"}));
          setLiveLabel(t("live.thinking"));
          rerender();
        } else if (d.type === "model") {
          // 実際に応答を生成しているモデル（クラウド側の強制切替を含む同期値）
          if (d.model && !shownActualModel) {
            shownActualModel = true;
            actions.push(t("model.actual", {model: d.model}));
            rerender();
          }
        } else if (d.type === "action") {
          actions.push(d.text);
          setLiveLabel("⚙ " + d.text);
          rerender();
        } else if (d.type === "tool_start") {
          // ツール入力がまとまる前の開始通知。名前だけ live に出す。
          if (d.name) setLiveLabel(t("live.running", {name: d.name}));
        } else if (d.type === "tool_use") {
          // 詳細は折りたたみ。表示はサマリ。
          toolResults.push({ name: d.name, input: d.input, id: d.tool_use_id });
        } else if (d.type === "tool_result") {
          const tr = toolResults.find(t => t.id === d.tool_use_id);
          if (tr) tr.result = d.content;
          setLiveLabel(t("live.thinking"));
        } else if (d.type === "token") {
          rawText += d.text;
          setLiveLabel(t("live.writing"));
          rerender();
        } else if (d.type === "done") {
          doneData = d; rawText = d.result || rawText;
        } else if (d.type === "error") {
          aiDiv.remove();
          const msg = d.text || t("stream.errOccurred");
          if (vis()) addMsg("error", msg);
          else addMsg("system", t("bg.error", { project: thisProjectName || thisProjectId, summary: msg.slice(0, 60) }));
          finish(); return;
        } else if (d.type === "canceled") {
          aiDiv.remove();
          if (vis()) { if (!_interrupting) addMsg("system", t("stream.aborted")); }
          finish(); return;
        }
      }
    }
    // done を見ずにストリームが切れた → 自動再接続（バックグラウンド復帰・瞬断対策）
    if (!doneData) {
      if (abort.signal.aborted) { aiDiv.remove(); finish(); return; }
      return await reconnect("ストリーム終了");
    }
    aiDiv.remove();
    const finalEl = buildAiMsgEl(rawText || t("out.none"), actions, doneData?.summary || "");
    if (toolResults.length) {
      const tr = document.createElement("div");
      tr.style.cssText = "margin-top:8px;padding:8px;background:rgba(0,0,0,0.3);border-radius:8px;border-left:3px solid var(--accent);";
      const btn = document.createElement("button");
      btn.style.cssText = "background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0;text-decoration:underline;";
      btn.textContent = t("tools.show", {n: toolResults.length});
      const body = document.createElement("div");
      body.style.cssText = "display:none;margin-top:8px;font-size:11px;color:var(--muted);font-family:monospace;line-height:1.5;max-height:300px;overflow-y:auto;background:rgba(0,0,0,0.5);padding:8px;border-radius:6px;";
      body.innerHTML = toolResults.map(t => {
        const inp = escapeHtml(JSON.stringify(t.input || {}).slice(0, 200));
        const res = escapeHtml((t.result || "(no result)").slice(0, 400));
        return `<div style="margin-bottom:8px;"><b style="color:#a5b4fc;">→ ${escapeHtml(t.name)}</b><br>in: ${inp}<br>out: ${res}</div>`;
      }).join("");
      btn.onclick = () => {
        const expanded = body.style.display === "none";
        body.style.display = expanded ? "block" : "none";
        btn.textContent = expanded ? t("tools.hide") : t("tools.show", {n: toolResults.length});
      };
      tr.appendChild(btn); tr.appendChild(body); finalEl.appendChild(tr);
    }
    // 💰 コスト・⏱時間・🔁ターン数は一切表示しない。Max/Pro プラン枠で動き API 課金は
    // 発生しないため（main.py 起動ガード + claude_code.py が ANTHROPIC_API_KEY を除去）、
    // コスト表示は課金の誤解を生むだけ。時間・ターン数もユーザーに不要なので出さない。
    const vaultNote = doneData?.vault_received > 0
      ? t("vault.received", { n: doneData.vault_received }) : "";
    if (vis()) {
      // 今見ているプロジェクトのジョブ → そのまま画面に出して保存。
      $messages.appendChild(finalEl);
      // 🔒金庫B方向: Claude が [[secret:名前]] で機密を返したら、サーバは実値を分離して
      // 件数だけ vault_received で知らせる。本文には [[secret:名前]] プレースホルダだけ残る。
      // 値そのものは SSE で流さない（漏洩面を作らない）方針。受信通知だけ出す。
      if (vaultNote) addMsg("system", vaultNote).classList.add("vault-link");
      stickToBottom();
      saveConversation();
    } else {
      // 裏で走っていたジョブ → 今の画面には積まず、そのプロジェクトの会話に保存して
      // 完了を一行知らせる。あとで切り替えれば全文が読める。
      appendToProjectConversation(thisProjectId, finalEl, vaultNote);
      const sum = (doneData?.summary || rawText || "").slice(0, 60);
      addMsg("system", t("bg.done", { project: thisProjectName || thisProjectId, summary: sum || "—" }));
    }
    notifyComplete(doneData?.summary || "");
  } catch (e) {
    if (e.name === "AbortError") {
      aiDiv.remove();
      if (vis() && !_interrupting) addMsg("system", t("stream.disconnected"));
      finish();
    } else {
      // fetch の TypeError(Failed to fetch) 等のネットワーク断 → 即あきらめず再接続
      return await reconnect("通信エラー");
    }
  } finally {
    finish();  // 多重呼び出しは settled で無視。reconnect 経路では既に委譲済み。
  }
}

document.getElementById("cancelBtn").onclick = async () => {
  // 中断ボタンは「全部止める」: 待ち行列も破棄し、実行中の全ジョブを停止する。
  const hadQueue = pendingQueue.length;
  pendingQueue = [];
  const ids = [...activeJobs.keys()];
  for (const jobId of ids) {
    try { await api(`/jobs/${jobId}/cancel`, "POST"); } catch {}
    const ab = activeJobs.get(jobId);
    if (ab) ab.abort();
  }
  const n = ids.length + hadQueue;
  if (n) addMsg("system", t("abort.nMsg", {n}));
};
document.getElementById("sendBtn").onclick = send;
// Enter キーは「改行のみ」。送信は紙飛行機ボタンだけ。
// 以前は Enter で送信していたが、長文や IME 中の誤送信が多発したため廃止。
$instruction.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    // 何もしない（textarea のデフォルト挙動 = 改行）
    return;
  }
});
$instruction.addEventListener("input", () => {
  // 上限は CSS の max-height (--app-h * 0.3) と整合させる。実測の可視領域基準なので
  // キーボードが出て画面が短い時も textarea が 3 割を超えず、ツールバーが必ず残る。
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const cap = Math.round(vh * 0.3);
  $instruction.style.height = "auto";
  $instruction.style.height = Math.min($instruction.scrollHeight, cap) + "px";
  syncAppHeight();   // 入力欄が伸縮したら #jumpBottom の浮かせ位置（--input-h）も更新
  saveDraft();       // 書きかけをプロジェクトごとに保存（リロード/再起動で消えない）
});

// ===== Git クイックアクション =====
async function gitAction(action, commitMsg = "") {
  if (!selectedProject) { showToast(t("toast.selectProject")); return; }
  const labels = { pull: "↓ Pull", commit: "✓ Commit", push: "↑ Push", status: "≡ Status" };
  addMsg("system", t("git.running", {label: labels[action]}));
  try {
    let r;
    if (action === "status") {
      r = await api(`/context/?project_path=${encodeURIComponent(selectedProject.path)}`);
      addMsg("ai", `**Git Status**\n\`\`\`\n${r.git_status || t("git.noChanges")}\n\`\`\`\n${t("git.branch")}: ${r.branch || t("git.unknownBranch")}`);
    } else if (action === "pull") {
      r = await api("/context/git-pull", "POST", { project_path: selectedProject.path });
      addMsg("ai", `${t("git.pullDone")}\n\`\`\`\n${r.result}\n\`\`\``);
    } else if (action === "commit") {
      r = await api("/context/git-commit", "POST", { project_path: selectedProject.path, message: commitMsg });
      addMsg("ai", `${t("git.commitDone")}\n\`\`\`\n${r.result}\n\`\`\``);
    } else if (action === "push") {
      r = await api("/context/git-push", "POST", { project_path: selectedProject.path });
      addMsg("ai", `${t("git.pushDone")}\n\`\`\`\n${r.result}\n\`\`\``);
    }
  } catch(e) { addMsg("error", e.message); }
}

document.getElementById("gitPullBtn").onclick   = () => gitAction("pull");
document.getElementById("gitStatusBtn").onclick  = () => gitAction("status");
document.getElementById("gitPushBtn").onclick    = () => gitAction("push");
document.getElementById("gitCommitBtn").onclick  = async () => {
  const msg = prompt(t("git.commitPrompt"));
  if (msg === null) return;
  await gitAction("commit", msg || "Update");
};

// ===== コンテキストボタン =====
let ctxTimer = null;
document.getElementById("contextBtn").onclick = () => {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(async () => {
    if (!selectedProject) { addMsg("system", t("toast.selectProject")); return; }
    setLoading(true);
    try {
      const r = await api("/context/summary?project_path=" + encodeURIComponent(selectedProject.path) + "&model=" + encodeURIComponent(effectiveRelayModel()) + "&effort=" + encodeURIComponent(effectiveRelayEffort()));
      addMsg("ai", r.summary);
    } catch(e) { addMsg("error", e.message); }
    finally { setLoading(false); }
  }, 300);
};
document.getElementById("dailyBtn").onclick = async () => {
  if (!selectedProject) { addMsg("system", t("toast.selectProject")); return; }
  setLoading(true);
  try {
    const r = await api("/context/daily?project_path=" + encodeURIComponent(selectedProject.path) + "&model=" + encodeURIComponent(effectiveRelayModel()) + "&effort=" + encodeURIComponent(effectiveRelayEffort()));
    addMsg("ai", r.report || r.error);
  } catch(e) { addMsg("error", e.message); }
  finally { setLoading(false); }
};

// ===== 送信履歴 =====
let _hist = JSON.parse(localStorage.getItem("sendHistory") || "[]");
let _histIdx = -1;
function pushHistory(t) {
  _hist = [t, ..._hist.filter(x => x !== t)].slice(0, 50);
  localStorage.setItem("sendHistory", JSON.stringify(_hist)); _histIdx = -1;
}
$instruction.addEventListener("keydown", e => {
  if (e.key === "ArrowUp" && !e.shiftKey && $instruction.value === "") {
    e.preventDefault(); _histIdx = Math.min(_histIdx + 1, _hist.length - 1);
    $instruction.value = _hist[_histIdx] || "";
  }
  // 履歴を遡っている最中（_histIdx>=0）だけ効かせる。無条件だと書きかけの本文が ↓ で消える。
  if (e.key === "ArrowDown" && !e.shiftKey && _histIdx >= 0) {
    e.preventDefault(); _histIdx = Math.max(_histIdx - 1, -1);
    $instruction.value = _histIdx >= 0 ? _hist[_histIdx] : "";
  }
}, true);

// ===== 会話履歴永続化 =====
function saveConversation() {
  const key = "conv_" + (selectedProject?.id || "default");
  // ストリーミング中の吹き出し（live-status/typing 入り）は保存しない。保存すると
  // 「考え中…」バッジ付きの途中本文が履歴に固まり、reattach の再生分と二重になる。
  const msgs = [...$messages.children]
    .filter(el => !el.id && !el.querySelector(".live-status, .typing-indicator"))
    .map(el => ({ cls: el.className, html: el.innerHTML })).slice(-80);
  localStorage.setItem(key, JSON.stringify(msgs));
}
// ===== 入力欄の下書き（プロジェクトごと） =====
// 中継なので「送る前の書きかけ」がリロード/アプリ再起動/プロジェクト切替で消えると地味に痛い。
// プロジェクトごとに draft_<id> へ保存し、そのプロジェクトを開いた時に復元する。
// 送信に成功したらそのプロジェクトの下書きは消す（残骸を残さない）。
function draftKey() { return "draft_" + (selectedProject?.id || "default"); }
function saveDraft() {
  const v = $instruction.value;
  if (v) localStorage.setItem(draftKey(), v);
  else localStorage.removeItem(draftKey());
}
function clearDraft() { localStorage.removeItem(draftKey()); }
function restoreDraft() {
  const v = localStorage.getItem(draftKey()) || "";
  $instruction.value = v;
  // 復元したテキストに合わせて高さも戻す。
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const cap = Math.round(vh * 0.3);
  $instruction.style.height = "auto";
  $instruction.style.height = Math.min($instruction.scrollHeight, cap) + "px";
  syncAppHeight();
}

function loadConversation() {
  $messages.innerHTML = "";
  const key = "conv_" + (selectedProject?.id || "default");
  const msgs = JSON.parse(localStorage.getItem(key) || "[]");
  if (msgs.length === 0) { renderWelcome(); }
  else msgs.forEach(m => {
    const d = document.createElement("div"); d.className = m.cls; d.innerHTML = m.html; $messages.appendChild(d);
  });
  // 同時進行: このプロジェクトのジョブが裏で走っていたら、そのライブ要素を
  // 今の画面に挿し込んで進捗を見えるようにする（切替で「裏→見える側」になった時）。
  for (const [, info] of jobInfo) {
    if (isJobVisible(info.projectId) && info.aiDiv && !info.aiDiv.isConnected) {
      $messages.appendChild(info.aiDiv);
    }
  }
  // 会話読込/プロジェクト切替は最下部から始める（追従を復活）。
  _stick = true;
  stickToBottom();
  restoreDraft();    // このプロジェクトの書きかけを入力欄に戻す
  updateBgBadge();   // 切替後の「裏で何件動いているか」を更新
}

// 裏で完了したジョブの結果を、そのプロジェクトの保存済み会話へ直接追記する。
// 画面には出さない（今は別プロジェクトを見ているため）。切り替えれば全文が読める。
function appendToProjectConversation(projectId, finalEl, vaultNote) {
  const key = "conv_" + (projectId || "default");
  const msgs = JSON.parse(localStorage.getItem(key) || "[]");
  msgs.push({ cls: finalEl.className, html: finalEl.innerHTML });
  if (vaultNote) msgs.push({ cls: "msg msg-system vault-link", html: escapeHtml(vaultNote) });
  localStorage.setItem(key, JSON.stringify(msgs.slice(-80)));
}

// 裏で走っているジョブ件数を、見える形（フローティングのバッジ）で示す。
function updateBgBadge() {
  let b = document.getElementById("bgBadge");
  const n = backgroundJobCount();
  if (n <= 0) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement("div");
    b.id = "bgBadge";
    b.style.cssText = "position:fixed;top:8px;right:8px;z-index:40;background:var(--accent,#6366f1);" +
      "color:#fff;font-size:12px;padding:4px 10px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);";
    document.body.appendChild(b);
  }
  b.textContent = t("bg.running", { n });
}

// ===== お気に入り =====
// onclick 属性に $instruction（const でグローバル非公開）を書くと ReferenceError で
// 登録ボタンが無反応になる。なので DOM を JS で組み立て、addEventListener で配線する。
// 削除・編集はインデックス（data-i）で特定する。data-text の HTML エスケープ往復に
// 依存しない＝同じ文字でも確実に一致する。
let _favs = JSON.parse(localStorage.getItem("favorites") || "[]");
function saveFavs() { localStorage.setItem("favorites", JSON.stringify(_favs)); }
function addCurrentFav() {
  const text = ($instruction.value || "").trim();
  if (!text) { showToast(t("toast.inputEmpty")); return; }
  if (_favs.includes(text)) { showToast(t("toast.alreadySaved")); return; }
  _favs = [text, ..._favs].slice(0, 12); saveFavs(); renderFavs(); showToast(t("toast.favAdded"));
}
function removeFavAt(i) { _favs.splice(i, 1); saveFavs(); renderFavs(); }
function editFavAt(i) {
  const cur = _favs[i];
  const next = prompt(t("fav.editPrompt"), cur);
  if (next === null) return;            // キャンセル
  const t = next.trim();
  if (!t) { removeFavAt(i); return; }   // 空にしたら削除
  _favs[i] = t; saveFavs(); renderFavs(); showToast(window.t("toast.edited"));
}
function useFavText(text) {
  $instruction.value = text;
  $instruction.style.height = "auto";
  $instruction.style.height = Math.min($instruction.scrollHeight, 320) + "px";
  $instruction.focus();
}
function renderFavs() {
  const $p = document.getElementById("favPanel");
  $p.textContent = "";
  if (!_favs.length) {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--muted);padding:2px 0;";
    hint.textContent = t("fav.hint");
    $p.appendChild(hint);
  }
  _favs.forEach((f, i) => {
    const chip = document.createElement("div");
    chip.className = "fav-chip";
    const label = document.createElement("span");
    label.textContent = f.length > 24 ? f.slice(0, 24) + "…" : f;
    label.style.cursor = "pointer";
    label.addEventListener("click", () => useFavText(f));
    const edit = document.createElement("button");
    edit.className = "fav-chip-del";
    edit.textContent = "✏️";
    edit.title = t("common.edit");
    edit.addEventListener("click", (e) => { e.stopPropagation(); editFavAt(i); });
    const del = document.createElement("button");
    del.className = "fav-chip-del";
    del.textContent = "×";
    del.title = t("common.delete");
    del.addEventListener("click", (e) => { e.stopPropagation(); removeFavAt(i); });
    chip.appendChild(label);
    chip.appendChild(edit);
    chip.appendChild(del);
    $p.appendChild(chip);
  });
  const add = document.createElement("button");
  add.className = "fav-add-btn";
  add.textContent = t("fav.add");
  add.addEventListener("click", addCurrentFav);
  $p.appendChild(add);
}
document.getElementById("favToggleBtn").onclick = () => {
  const $p = document.getElementById("favPanel");
  document.getElementById("histPanel").classList.remove("open"); // 片方だけ開く
  $p.classList.toggle("open");
  if ($p.classList.contains("open")) renderFavs();
};

// ===== 送信履歴パネル（スマホ向け。↑↓キーが無くてもタップで過去の指示を呼べる） =====
function renderHist() {
  const $p = document.getElementById("histPanel");
  if (!_hist.length) {
    $p.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:2px 0;">${t("list.noHist")}</div>`;
    return;
  }
  $p.innerHTML = _hist.map(t => {
    const short = t.length > 28 ? t.slice(0, 28) + "…" : t;
    return `<div class="fav-chip" onclick="useHist(this)" data-text="${escapeHtml(t).replace(/"/g,"&quot;")}"><span>🕘 ${escapeHtml(short)}</span></div>`;
  }).join("");
}
function useHist(el) {
  $instruction.value = el.dataset.text;
  $instruction.style.height = "auto";
  $instruction.style.height = Math.min($instruction.scrollHeight, 320) + "px";
  $instruction.focus();
  document.getElementById("histPanel").classList.remove("open");
}
document.getElementById("histToggleBtn").onclick = () => {
  const $p = document.getElementById("histPanel");
  document.getElementById("favPanel").classList.remove("open"); // 片方だけ開く
  $p.classList.toggle("open");
  if ($p.classList.contains("open")) renderHist();
};

// ===== モデル切替ピル（Claude Code のみ）。がんばり度(effort)は設定ドロワーへ移設。 =====
function updatePills() {
  const $mp = document.getElementById("modelPill");
  if ($mp) {
    const eff = effectiveJobSettings(selectedProject?.id);
    const m = eff.model;
    $mp.style.display = m ? "" : "none";
    // プロジェクト個別設定が効いている時は 📁 を付けて区別する
    if (m) $mp.textContent = (eff.hasOverride ? "📁 " : "") + m;
  }
}
// effort セレクトを CLI の実際の候補で組み直す。段階はクラウド側 CLI 更新で
// 増減しうるので固定リストにせず /jobs/capabilities から拾う。取得前や失敗時は
// HTML に元からある option をそのまま使う（＝安全側フォールバック）。
let _effortLevels = null;  // 取得済みなら文字列配列
async function refreshEffortOptions() {
  const $sel = document.getElementById("drawerCcEffort");
  if (!$sel) return;
  try {
    const caps = await api("/jobs/capabilities");
    const levels = Array.isArray(caps.effortLevels) ? caps.effortLevels : null;
    if (!levels || !levels.length) return;
    _effortLevels = levels;
    // 作業(ccEffort)と中継(relayEffort)の両セレクトを同じ CLI 候補で組み直す。
    // どちらも先頭は「auto（空値）」固定。廃止された段階を保存していたら auto に戻す。
    const rebuild = (selId, saveKey) => {
      const $s = document.getElementById(selId);
      if (!$s) return;
      const cur = getSettings()[saveKey] || "";
      let html = `<option value="">${t("effort.auto")}</option>`;
      for (const lv of levels) html += `<option value="${lv}">${lv}</option>`;
      $s.innerHTML = html;
      $s.value = levels.includes(cur) ? cur : "";
      if (!levels.includes(cur) && cur) saveSettings({ [saveKey]: "" });
    };
    rebuild("drawerCcEffort", "ccEffort");
    rebuild("drawerRelayEffort", "relayEffort");
  } catch { /* 取得失敗は既存 option のまま。次回開いた時に再挑戦。 */ }
}

const _modelPillEl = document.getElementById("modelPill");
if (_modelPillEl) {
  _modelPillEl.onclick = () => {
    const s = getSettings();
    const cycle = ["", "haiku", "sonnet", "opus"];
    const idx = cycle.indexOf(s.ccModel);
    const next = cycle[(idx + 1) % cycle.length];
    saveSettings({ ccModel: next });
    showToast(t("toast.modelSet", {model: next || t("common.defaultModel")}));
    updatePills();
  };
}

// ===== TTS =====
function speak(text, btn) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, t("tts.code")).replace(/[#*`]/g, ""));
  utt.lang = (window.getLang && getLang() === "en") ? "en-US" : "ja-JP"; utt.rate = 1.1;
  if (btn) { btn.classList.add("speaking"); utt.onend = () => btn.classList.remove("speaking"); }
  speechSynthesis.speak(utt);
}

// ===== ブラウザ通知 =====
async function requestNotificationPermission() {
  try {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    // requestPermission() が解決しない端末対策：3秒で諦める（権限は次回起動で再要求される）。
    // これで万一 init が誤って await しても固着しない二重防御。
    await Promise.race([
      Notification.requestPermission(),
      new Promise((res) => setTimeout(res, 3000)),
    ]);
  } catch {}
}
function notifyComplete(summary) {
  if (!("Notification" in window)) return;   // iOS Safari 非PWA 等。未ガードだと完了時に投げ→誤再接続
  if (document.visibilityState !== "hidden" || Notification.permission !== "granted") return;
  // Android Chrome はページからの直 new Notification が常に throw（SW経由必須）。
  // streamJob の try 内から呼ばれるため、投げると完了済みジョブへの誤再接続→出力二重化になる。
  try { new Notification(t("notif.title"), { body: summary || t("notif.body"), icon: "/ui/icon.svg" }); } catch {}
}

// 設定ドロワーの「通知」セクションの表示を、今のブラウザ許可状態に合わせて更新する。
// ⚠️ ここはローカル通知（アプリを開いている間だけ）の可視化のみ。閉じても届く Web Push は未実装。
function refreshNotifyUI() {
  const $st = document.getElementById("notifyStatus");
  const $btn = document.getElementById("notifyToggleBtn");
  if (!$st || !$btn) return;
  if (!("Notification" in window)) {
    $st.textContent = t("notify.unsupported");
    $btn.style.display = "none";
    return;
  }
  const p = Notification.permission;  // "default" | "granted" | "denied"
  if (p === "granted") {
    $st.textContent = t("notify.on");
    $btn.style.display = "none";
  } else if (p === "denied") {
    $st.textContent = t("notify.denied");
    $btn.style.display = "none";   // 一度拒否すると JS からは再要求できない（端末設定で解除）
  } else {
    $st.textContent = t("notify.off");
    $btn.style.display = "";
  }
}
(function wireNotifyToggle() {
  const $btn = document.getElementById("notifyToggleBtn");
  if (!$btn) return;
  $btn.onclick = async () => {
    await requestNotificationPermission();
    refreshNotifyUI();
    refreshPushUI();
  };
})();

// ===== Web Push（スリープ中・アプリ閉でも届く通知） =====
// PC側(agent)がジョブ完了時に push サービス経由で送る。購読はこの端末の SW に紐づく。
function _pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function _urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function _getPushSub() {
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}
async function refreshPushUI() {
  const $st = document.getElementById("pushStatus");
  const $en = document.getElementById("pushEnableBtn");
  const $test = document.getElementById("pushTestBtn");
  if (!$st || !$en || !$test) return;
  if (!_pushSupported()) {
    // iOS はホーム画面に追加した PWA でのみ対応。非対応環境では丸ごと隠す。
    $st.textContent = t("push.unsupported");
    $en.style.display = "none"; $test.style.display = "none";
    return;
  }
  const sub = await _getPushSub();
  if (sub) {
    $st.textContent = t("push.on");
    $en.style.display = "none";
    $test.style.display = "";
  } else {
    $st.textContent = t("push.off");
    $en.style.display = Notification.permission === "denied" ? "none" : "";
    $test.style.display = "none";
  }
}
async function enablePush() {
  try {
    if (Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") { refreshNotifyUI(); refreshPushUI(); return; }
    }
    const { key } = await api("/push/pubkey");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlB64ToUint8(key),
    });
    await api("/push/subscribe", "POST", { subscription: sub.toJSON() });
    showToast(t("push.enabled"));
  } catch (e) {
    showToast(t("push.failed"));
  }
  refreshNotifyUI();
  refreshPushUI();
}
(function wirePushButtons() {
  const $en = document.getElementById("pushEnableBtn");
  const $test = document.getElementById("pushTestBtn");
  if ($en) $en.onclick = enablePush;
  if ($test) $test.onclick = async () => {
    try { await api("/push/test", "POST", {}); showToast(t("push.testSent")); }
    catch { showToast(t("push.failed")); }
  };
})();

// ===== プロジェクト別オーバーライド（設定ドロワー内） =====
// 空値＝共通設定どおり。値があるものだけ localStorage の projOverrides に残す。
function refreshProjOverrideUI() {
  const $sec = document.getElementById("projOverrideSection");
  if (!$sec) return;
  if (!selectedProject) { $sec.style.display = "none"; return; }
  $sec.style.display = "";
  document.getElementById("projOverrideName").textContent = t("proj.overrideFor", {name: selectedProject.name});
  const o = getProjOverrides(selectedProject.id);
  document.getElementById("drawerProjModel").value        = o.model || "";
  document.getElementById("drawerProjModelCustom").value  = o.modelCustom || "";
  document.getElementById("drawerProjEffort").value       = o.effort || "";
  document.getElementById("drawerProjThinking").value     = o.thinking || "";
}
(function wireProjOverride() {
  const ids = ["drawerProjModel", "drawerProjModelCustom", "drawerProjEffort", "drawerProjThinking"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", () => {
      if (!selectedProject) return;
      saveProjOverrides(selectedProject.id, {
        model:       document.getElementById("drawerProjModel").value,
        modelCustom: document.getElementById("drawerProjModelCustom").value.trim(),
        effort:      document.getElementById("drawerProjEffort").value,
        thinking:    document.getElementById("drawerProjThinking").value,
      });
      updatePills();
      showToast(t("toast.saved"));
    });
  }
})();

// ===== プロジェクト管理（一覧＋追加＋削除） =====
function renderProjManageList() {
  const $list = document.getElementById("projManageList");
  if (!$list) return;
  if (!projects.length) { $list.innerHTML = `<div style="font-size:12px;color:var(--muted);">${t("proj.none")}</div>`; return; }
  $list.innerHTML = projects.map(p => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;">${escapeHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.path)}</div>
      </div>
      <button class="btn-sm proj-del-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">🗑</button>
    </div>`).join("");
  $list.querySelectorAll(".proj-del-btn").forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name;
      if (!confirm(t("proj.delConfirm", {name}))) return;
      try {
        await api(`/projects/${btn.dataset.id}`, "DELETE");
        await loadProjects();
        renderProjManageList();
        refreshProjOverrideUI();
        showToast(t("proj.deleted", {name}));
      } catch (e) { showToast(e.message); }
    };
  });
}
(function wireProjAdd() {
  const $btn = document.getElementById("projAddBtn");
  if (!$btn) return;
  $btn.onclick = async () => {
    const name = document.getElementById("projAddName").value.trim();
    const path = document.getElementById("projAddPath").value.trim();
    if (!name || !path) { showToast(t("toast.enterNamePath")); return; }
    try {
      await api("/projects/", "POST", { name, path, description: "" });
      document.getElementById("projAddName").value = "";
      document.getElementById("projAddPath").value = "";
      await loadProjects();
      renderProjManageList();
      showToast(t("proj.added", {name}));
    } catch (e) { showToast(e.message); }
  };
})();

// ===== ユーティリティ =====
function showToast(msg, onClick) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  // onClick 付きはタップ可能トースト（リンク風・長め表示）。押したら即消して実行。
  if (onClick) {
    t.classList.add("tappable");
    t.addEventListener("click", () => { t.remove(); onClick(); });
  }
  document.body.appendChild(t); setTimeout(() => t.remove(), onClick ? 5000 : 1800);
}
// 送信ボタンの「押した合図」ポップ。.sent を付け直して CSS アニメを再生する。
// 連打しても毎回光るよう、一度クラスを外して reflow を挟んでから付け直す。
function pulseSendBtn() {
  if (!$sendBtn) return;
  $sendBtn.classList.remove("sent");
  void $sendBtn.offsetWidth;   // reflow を強制してアニメを最初から再生
  $sendBtn.classList.add("sent");
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }  // 触覚フィードバック（対応端末のみ）
  setTimeout(() => $sendBtn.classList.remove("sent"), 450);
}
// 接続ステータスの帯。fixed なのでレイアウトを一切押し出さない。
// msg を渡すと表示、null で消す。isErr=true で赤帯。
function setConnBar(msg, isErr = false) {
  const b = document.getElementById("connBar");
  if (!b) return;
  if (!msg) { b.classList.remove("visible", "err"); b.textContent = ""; return; }
  b.textContent = msg;
  b.classList.toggle("err", !!isErr);
  b.classList.add("visible");
}

// ===== プロジェクト切り替え（スワイプ） =====
function switchProject(dir) {
  if (!projects.length) return;
  const idx = projects.findIndex(p => p.id === selectedProject?.id);
  const next = (idx + dir + projects.length) % projects.length;
  selectedProject = projects[next];
  $projSelect.value = selectedProject.id;
  localStorage.setItem("selectedProjectId", selectedProject.id);
  loadConversation();
  updatePills();
  showToast("📁 " + selectedProject.name);
}

// ===== プルリフレッシュ =====
async function doRefresh() {
  const $pull = document.getElementById("pullIndicator");
  $pull.textContent = t("pull.refreshing"); $pull.classList.add("visible");
  await checkHealth(); await loadProjects();
  $pull.classList.remove("visible"); $pull.textContent = t("pull.release");
  showToast(t("toast.updated"));
}

// ===== ジェスチャー =====
(function setupGestures() {
  let startX = 0, startY = 0, startScrollTop = 0, longPressTimer = null;
  const PULL = 65, SWIPE = 80;

  $messages.addEventListener("touchstart", e => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    startScrollTop = $messages.scrollTop;
    const msg = e.target.closest(".msg");
    if (msg) longPressTimer = setTimeout(() => {
      const clone = msg.cloneNode(true);
      clone.querySelectorAll("div[style],button").forEach(el => el.remove());
      navigator.clipboard?.writeText(clone.textContent.trim()).then(() => showToast(t("toast.copied")));
    }, 500);
  }, { passive: true });

  $messages.addEventListener("touchmove", e => {
    clearTimeout(longPressTimer);
    const dy = e.touches[0].clientY - startY;
    if (startScrollTop === 0 && dy > 20) {
      document.getElementById("pullIndicator").classList.toggle("visible", dy > PULL);
    }
  }, { passive: true });

  $messages.addEventListener("touchend", e => {
    clearTimeout(longPressTimer);
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const scrolled = Math.abs($messages.scrollTop - startScrollTop);
    document.getElementById("pullIndicator").classList.remove("visible");
    if (startScrollTop === 0 && dy > PULL && Math.abs(dx) < 50) { doRefresh(); return; }
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5 && scrolled < 30) switchProject(dx < 0 ? 1 : -1);
  }, { passive: true });
  $messages.addEventListener("touchcancel", () => clearTimeout(longPressTimer), { passive: true });
})();

// メッセージ内ボタン（📋コピー / 🔊読み上げ / コードブロック📋）の委譲ハンドラ。
// buildAiMsgEl / addMsg の onclick は「生成直後」しか効かない。リロード後は
// loadConversation が innerHTML から復元するので onclick が失われる。委譲なら
// 自分の書き込みも AI 返答も、リロードの前後どちらでもボタンが効く。
// rawText は data 属性（HTML に残る）から取り、無ければ吹き出しのテキストで代替する。
$messages.addEventListener("click", e => {
  // 🔒「金庫が機密を受け取りました」行 → タップで金庫を開く（class は innerHTML 保存/
  // 復元でも残るので、リロード後の会話からでも効く）。
  if (e.target.closest(".vault-link")) { openVault(); return; }
  // 選択肢ボタン: タップで答えを次の指示として送る。同じ吹き出しの他の選択肢は無効化。
  const choiceBtn = e.target.closest(".choice-btn");
  if (choiceBtn) {
    if (choiceBtn.disabled) return;
    const box = choiceBtn.closest(".choice-box");
    box?.querySelectorAll(".choice-btn").forEach(x => { x.disabled = true; });
    choiceBtn.classList.add("chosen");
    submitChoice(choiceBtn.dataset.answer || choiceBtn.textContent.trim());
    return;
  }
  const btn = e.target.closest(".copy-btn, .tts-btn, .code-copy-btn");
  if (!btn) return;
  const msg = btn.closest(".msg");
  if (btn.classList.contains("code-copy-btn")) {
    const code = btn.closest("pre")?.querySelector("code");
    if (code) copyText(code.textContent, btn);
    return;
  }
  // 吹き出し本文（ボタン行・装飾 div を除いた素のテキスト）を取り出す。
  function msgText() {
    if (msg?.dataset.rawText) return msg.dataset.rawText;
    const clone = msg?.cloneNode(true);
    clone?.querySelectorAll(".msg-actions, button").forEach(el => el.remove());
    return (clone?.textContent || "").trim();
  }
  if (btn.classList.contains("tts-btn")) {
    if (btn.classList.contains("speaking")) { speechSynthesis.cancel(); btn.classList.remove("speaking"); return; }
    speak(msgText(), btn);
  } else {
    copyText(msgText(), btn);
  }
});

// ===== 設定ドロワー =====
function openDrawer() {
  const s = getSettings();
  document.getElementById("drawerUrl").value        = s.url;
  document.getElementById("drawerCcModel").value    = s.ccModel;
  document.getElementById("drawerCcModelCustom").value = s.ccModelCustom || "";
  document.getElementById("drawerRelayModel").value = s.relayModel || "";
  document.getElementById("drawerRelayModelCustom").value = s.relayModelCustom || "";
  document.getElementById("drawerRelayEffort").value = s.relayEffort || "";
  document.getElementById("drawerCcEffort").value   = s.ccEffort || "";
  refreshEffortOptions();  // CLI の実候補で組み直す（クラウド更新に追随）。非同期・失敗は既存optionのまま
  document.getElementById("drawerThinking").value   = s.ccThinking || "on";
  document.getElementById("drawerPermMode").value   = s.permMode;
  document.getElementById("drawerVscodeName").value = s.vscodeName;
  // 再認証間隔: 設定値に最も近い選択肢を選ぶ（範囲外保存値でも UI が空にならない）。
  const $vl = document.getElementById("drawerVaultLock");
  if ($vl) {
    const opts = [...$vl.options].map(o => parseInt(o.value, 10));
    const nearest = opts.reduce((a, b) => Math.abs(b - s.vaultLockMs) < Math.abs(a - s.vaultLockMs) ? b : a, opts[0]);
    $vl.value = String(nearest);
  }
  updateAuthStatusLine();
  refreshNotifyUI();
  refreshPushUI();
  refreshProjOverrideUI();
  renderProjManageList();
  document.getElementById("settingsDrawer").classList.add("open");
  document.getElementById("drawerOverlay").classList.add("open");
  passkeyRefreshUI();
}

// 接続セクションに今の認証状態を 1 行で出す（トークン欄の代わり）。
function updateAuthStatusLine() {
  const el = document.getElementById("authStatusLine");
  if (!el) return;
  const jwt = localStorage.getItem("passkeyJwt");
  if (jwt && jwtValid(jwt)) {
    try {
      const p = jwtPayload(jwt);
      const left = Math.max(0, p.exp - Math.floor(Date.now()/1000));
      el.innerHTML = t("pk.authed", {name: escapeHtml(p.name||t("common.thisDevice")), days: Math.floor(left/86400)});
    } catch {
      el.innerHTML = t("pk.authedShort");
    }
  } else if (getSettings().token) {
    el.innerHTML = t("pk.tokenMode");
  } else {
    el.innerHTML = t("pk.unauthed");
  }
}
function closeDrawer() {
  // 保存ボタン廃止に伴い、閉じる操作で確定保存（自動保存済みでも取りこぼしを防ぐ）。
  try { persistDrawerSettings(); } catch {}
  document.getElementById("settingsDrawer").classList.remove("open");
  document.getElementById("drawerOverlay").classList.remove("open");
}
document.getElementById("settingsBtn").onclick  = openDrawer;

// ===== 使い方ヘルプ =====
const _helpModal = document.getElementById("helpModal");
document.getElementById("helpBtn").onclick = () => { closeDrawer(); _helpModal.style.display = "flex"; };
_helpModal.addEventListener("click", e => { if (e.target === _helpModal) _helpModal.style.display = "none"; });
// ヘルプ内の <code class="help-copy"> はタップで中身をコピー（金庫の {{名前}} / [[secret:名前]] 例）。
// 委譲で配線＝言語切替で help.body が差し替わっても効く。値そのものは含まない雛形だけ。
_helpModal.addEventListener("click", e => {
  const code = e.target.closest(".help-copy");
  if (!code) return;
  navigator.clipboard?.writeText(code.textContent.trim()).then(() => showToast(t("toast.copied")));
});
document.getElementById("drawerOverlay").onclick = closeDrawer;
document.getElementById("drawerClose").onclick = closeDrawer;
// 設定ドロワーの全項目を localStorage へ書き出す。保存ボタンと自動保存の両方から呼ぶ。
function persistDrawerSettings() {
  saveSettings({
    url:        document.getElementById("drawerUrl").value.trim(),
    ccModel:    document.getElementById("drawerCcModel").value,
    ccModelCustom: document.getElementById("drawerCcModelCustom").value.trim(),
    relayModel: document.getElementById("drawerRelayModel").value,
    relayModelCustom: document.getElementById("drawerRelayModelCustom").value.trim(),
    relayEffort: document.getElementById("drawerRelayEffort").value,
    ccEffort:   document.getElementById("drawerCcEffort").value,
    ccThinking: document.getElementById("drawerThinking").value,
    permMode:   document.getElementById("drawerPermMode").value,
    vscodeName: document.getElementById("drawerVscodeName").value.trim(),
    vaultLockMs: parseInt(document.getElementById("drawerVaultLock").value, 10),
  });
  // 開錠中なら新しい間隔でタイマーを張り直す（次回開錠を待たず即反映）。
  if (typeof vaultSecrets !== "undefined" && vaultSecrets !== null) vaultResetLockTimer();
  updatePills();
}

// 各項目を「変えた瞬間に保存」。押し忘れで設定が効かない事故を無くす。
// select は change、text/url は入力が落ち着いた所（change=フォーカスアウト時）で保存。
(function wireAutoSaveSettings() {
  const ids = ["drawerUrl", "drawerCcModel", "drawerCcModelCustom",
               "drawerRelayModel", "drawerRelayModelCustom", "drawerRelayEffort",
               "drawerCcEffort", "drawerThinking", "drawerPermMode", "drawerVscodeName", "drawerVaultLock"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", () => {
      persistDrawerSettings();
      showToast(t("toast.saved") || "保存しました");
    });
  }
})();

// 保存ボタンは廃止（変えた瞬間に自動保存＝押し忘れ事故を無くす）。closeDrawer 側で
// 閉じる時に一度だけ確定保存するようにした（下の closeDrawer 定義参照）。

// ===== 再起動 =====
document.getElementById("restartBtn").onclick = async () => {
  if (!confirm(t("confirm.restart"))) return;
  closeDrawer();
  try {
    await api("/restart", "POST");
    addMsg("system", t("restart.inProgress"));
    $statusDot.className = "status-dot"; $statusDot.style.background = "var(--yellow)"; $statusText.textContent = t("status.restarting");
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      const ok = await checkHealth();
      if (ok === true || tries >= 12) {
        clearInterval(poll);
        if (ok === true) { addMsg("system", t("restart.done")); await loadProjects(); }
        else addMsg("error", t("restart.failed"));
      }
    }, 3000);
  } catch(e) { addMsg("error", e.message); }
};

// ===== 履歴クリア =====
document.getElementById("clearHistoryBtn").onclick = () => {
  if (!confirm(t("confirm.clearHistory"))) return;
  $messages.innerHTML = ""; renderWelcome();
  const key = "conv_" + (selectedProject?.id || "default");
  localStorage.removeItem(key);
  showToast(t("history.cleared")); closeDrawer();
};

// ===== シャットダウン =====
document.getElementById("shutdownBtn").onclick = async () => {
  if (!confirm(t("confirm.shutdown"))) return;
  try { await api("/shutdown", "POST"); } catch {}
  addMsg("system", t("shutdown.done"));
  $statusDot.className = "status-dot off"; $statusDot.style.background = ""; $statusText.textContent = t("status.stopped");
  closeDrawer();
};

// ===== プロジェクト追加 =====
function openProjectDrawer()  { document.getElementById("addProjectDrawer").classList.add("open"); document.getElementById("projectOverlay").classList.add("open"); }
function closeProjectDrawer() { document.getElementById("addProjectDrawer").classList.remove("open"); document.getElementById("projectOverlay").classList.remove("open"); }
document.getElementById("addProjectBtn").onclick   = openProjectDrawer;
document.getElementById("projectOverlay").onclick  = closeProjectDrawer;
document.getElementById("projCancel").onclick      = closeProjectDrawer;
document.getElementById("projSave").onclick = async () => {
  const name = document.getElementById("projName").value.trim();
  const path = document.getElementById("projPath").value.trim();
  if (!name || !path) { alert(t("toast.enterNamePath")); return; }
  try {
    await api("/projects/", "POST", { name, path, description: "" });
    closeProjectDrawer();
    document.getElementById("projName").value = ""; document.getElementById("projPath").value = "";
    await loadProjects(); addMsg("system", t("proj.added", {name}));
  } catch(e) { addMsg("error", e.message); }
};

// ===== ファイルツリー =====
let _treePath = [];
async function openFileTree() {
  if (!selectedProject) { showToast(t("toast.selectProject")); return; }
  _treePath = [selectedProject.path];
  document.getElementById("fileTreeDrawer").classList.add("open");
  document.getElementById("fileTreeOverlay").classList.add("open");
  await loadTreeDir(selectedProject.path);
}
async function loadTreeDir(path) {
  document.getElementById("fileTreeTitle").textContent = path.split(/[\\/]/).pop();
  const $c = document.getElementById("fileTreeContent");
  $c.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("common.loading")}</div>`;
  try {
    const result = await api("/command/", "POST", {
      instruction: `list_files ツールで "${path}" のファイル一覧を取得して。[フォルダ] と [ファイル] プレフィックスで列挙し、それ以外は出力しないで。`,
      project_path: path,
      model_override: effectiveRelayModel(),   // 中継（一覧取得）は中継モデル設定。作業（指示実行）だけ Opus。
      effort: effectiveRelayEffort(),          // 中継の effort（空欄なら CLI 既定）。
    });
    const lines = (result.result || "").split("\n").filter(Boolean);
    $c.innerHTML = "";
    if (_treePath.length > 1) {
      const back = document.createElement("div");
      back.className = "tree-item folder"; back.textContent = t("file.upTitle");
      back.onclick = () => { _treePath.pop(); loadTreeDir(_treePath[_treePath.length - 1]); };
      $c.appendChild(back);
    }
    lines.forEach(line => {
      const isDir = line.includes("[フォルダ]");
      const name = line.replace(/\[(フォルダ|ファイル)\]\s*/g, "").trim();
      const item = document.createElement("div");
      item.className = "tree-item " + (isDir ? "folder" : "");
      item.textContent = (isDir ? "📁 " : "📄 ") + name;
      item.onclick = () => {
        const full = path.replace(/[\\/]+$/, "") + "\\" + name;
        if (isDir) { _treePath.push(full); loadTreeDir(full); }
        else { closeFileTree(); $instruction.value = t("file.showContent", {path: full}); $instruction.dispatchEvent(new Event("input")); }
      };
      $c.appendChild(item);
    });
    if (!lines.length) $c.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("list.noFiles")}</div>`;
  } catch(e) { $c.innerHTML = `<div style="color:var(--red);font-size:13px;">${e.message}</div>`; }
}
function closeFileTree() {
  document.getElementById("fileTreeDrawer").classList.remove("open");
  document.getElementById("fileTreeOverlay").classList.remove("open");
}
document.getElementById("fileTreeBtn").onclick      = openFileTree;
document.getElementById("fileTreeClose").onclick    = closeFileTree;
document.getElementById("fileTreeOverlay").onclick  = closeFileTree;

// ===== PWA インストール =====
let _installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); _installPrompt = e; });
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function openInstallModal() {
  const modal = document.getElementById("installModal");
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const $ios = document.getElementById("installIos");
  const $android = document.getElementById("installAndroid");
  const $promptBtn = document.getElementById("installPromptBtn");
  const $done = document.getElementById("installDone");
  if (isStandalone()) {
    // すでにアプリとして起動中
    $ios.style.display = "none"; $android.style.display = "none"; $promptBtn.style.display = "none";
    if ($done) $done.style.display = "block";
  } else {
    if ($done) $done.style.display = "none";
    $ios.style.display     = isIos ? "block" : "none";
    $android.style.display = isIos ? "none"  : "block";
    // Chrome がインストール可能と判定していれば、ワンタップのインストールボタンを出す
    $promptBtn.style.display = (_installPrompt && !isIos) ? "block" : "none";
  }
  modal.style.display = "flex"; closeDrawer();
}
function closeInstallModal() { document.getElementById("installModal").style.display = "none"; }
document.getElementById("installModal").addEventListener("click", e => { if (e.target === document.getElementById("installModal")) closeInstallModal(); });
document.getElementById("installAppBtn").onclick = openInstallModal;
document.getElementById("installPromptBtn").onclick = async () => {
  if (!_installPrompt) return;
  _installPrompt.prompt(); await _installPrompt.userChoice; _installPrompt = null; closeInstallModal();
};

// ===== ワンクリック更新（SW・キャッシュを捨てて最新版を取り直す） =====
async function forceUpdateApp() {
  showToast(t("toast.updating"));
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { try { await r.update(); } catch {} }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch {}
  // キャッシュを消したので次のロードは必ずサーバから最新を取得する
  location.reload();
}
document.getElementById("updateAppBtn").onclick = () => forceUpdateApp();

// ===== 音声入力（日本語） =====
// 根本設計（過去の重複バグを断つ）:
//   状態は3つだけ。
//     micBase    = 録音開始時点の入力欄テキスト（録音中は不変）
//     micFinal   = この録音で「確定」した語を連結した文字列（確定するたびに追記）
//     interim    = 今まさに喋っている途中の暫定テキスト（確定で必ず置き換わる）
//   表示は常に  micBase + micFinal + interim  を組み立て直すだけ。
//
// 過去バグの真因:
//   旧コードは onresult で毎回「micBase + results全体」を入力欄に入れ、かつ onend で
//   その入力欄の値を micBase に焼き戻していた。continuous=true だとゆっくり喋るたびに
//   onend が頻発し、確定済み results が micBase に取り込まれ、次の onresult でまた
//   results 全体が足されて二重・多重化していた（「ゆっくり→重複」「続けると大量重複」）。
//
// 今回の対処:
//   1) continuous=false。1発話ごとにブラウザが自然に確定して止まる＝「会話が終わったら
//      止める」という要望そのもの。自動再開もしない。
//   2) 確定は resultIndex を基準に「新しく確定したセルだけ」を micFinal に追記する。
//      results 全体を毎回足さないので、results が何度返っても二重化しない。
//   3) onend では micBase / micFinal を一切いじらない（焼き戻しが重複の元凶だった）。
let recognition = null;
let micActive = false;
let micBase = "";       // 録音開始時点の入力欄テキスト（録音中は不変）
let micFinal = "";      // この録音で確定した語の連結
// 音声の書き込み先 textarea/input。既定はチャット入力欄。金庫の値入力欄でも
// 音声を使えるよう、startMic 時に差し替える（暗証番号・値をチャットに残さず入れる）。
let micTarget = $instruction;
let _micBtnActive = $micBtn;   // 録音中表示を出しているボタン（チャット or 金庫）
const MIC_DEBUG = new URLSearchParams(location.search).get("micdebug") === "1";

// 2つの文字列を、必要なときだけ空白1つでつなぐ（二重空白は作らない）。
function micJoin(base, add) {
  if (!base) return add;
  if (!add) return base;
  return /\s$/.test(base) || /^\s/.test(add) ? base + add : base + " " + add;
}

// 現在の表示文字列を組み立てて書き込み先（micTarget）へ反映する。
function micRender(interim) {
  const txt = micJoin(micJoin(micBase, micFinal), interim.trim());
  micTarget.value = txt;
  micTarget.dispatchEvent(new Event("input"));   // textarea の高さ再計算等を発火
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// iOS(iPhone/iPad) は Web Speech が不安定なので、アプリ内マイクは出さず
// ネイティブのキーボード音声入力（🎤キー）にフォールバックさせる。
const _isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (!SR || _isIOS) {
  // 非対応ブラウザ / iOS ではボタン自体を隠す（iOS はキーボードの🎤で音声入力）
  $micBtn.style.display = "none";
} else {
  recognition = new SR();
  recognition.lang = "ja-JP";
  recognition.continuous = false;       // 1発話で自然に確定・停止（重複の根を断つ）
  recognition.interimResults = true;    // 入力中も暫定テキストを表示

  recognition.onresult = e => {
    // e.resultIndex 以降が「今回新しく届いた分」。確定(isFinal)はそこだけ micFinal に
    // 追記し、未確定は interim として描画する。results 全体を足し直さないので、
    // ブラウザが results を何度返しても、ゆっくり喋っても二重化しない。
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = e.results[i][0].transcript;
      if (e.results[i].isFinal) micFinal = micJoin(micFinal, seg.trim());
      else interim += seg;
    }
    if (MIC_DEBUG) {
      const dump = Array.from(e.results).map(r => (r.isFinal ? "✓" : "·") + r[0].transcript).join(" | ");
      showToast("🎤 idx=" + e.resultIndex + " [" + dump + "]");
    }
    micRender(interim);
  };

  recognition.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      showToast(t("mic.notAllowed"));
    } else if (e.error === "no-speech") {
      showToast(t("mic.noSpeech"));
    } else if (e.error === "audio-capture") {
      showToast(t("mic.noMic"));
    } else if (e.error !== "aborted") {
      showToast(t("mic.err", {err: e.error}));
    }
    resetMicUI();
  };

  recognition.onend = () => {
    // 自然停止（1発話の終わり）。自動再開しない＝「会話が終わったら止める」。
    // micBase / micFinal は触らない（焼き戻しが過去の重複バグの元凶だった）。
    // 確定済みテキストは既に入力欄にあるので、続けたければマイクを押し直す。
    if (MIC_DEBUG) showToast("🎤 onend（停止）");
    resetMicUI();
  };
}

function resetMicUI() {
  micActive = false;
  // 録音表示を出していたボタンを戻す（チャット🎤 or 金庫🎤 どちらでも）。
  if (_micBtnActive) _micBtnActive.classList.remove("active");
  $micBtn.classList.remove("active");
  $micBtn.textContent = "🎤";
  $micBtn.title = t("mic.title");
  micTarget = $instruction;   // 次回の既定をチャット入力欄に戻す
  _micBtnActive = $micBtn;
}

// target を渡すとそこへ書き込む（既定はチャット入力欄）。btn は録音中表示を切り替える
// ボタン（既定は $micBtn）。金庫の値入力欄から呼ぶときは両方を金庫側に差し替える。
function startMic(target, btn) {
  if (!recognition || micActive) return;
  micTarget = target || $instruction;
  _micBtnActive = btn || $micBtn;
  micBase = micTarget.value.trim();      // 既存入力を土台に追記する
  micFinal = "";                         // この録音の確定分はゼロから
  micActive = true;
  _micBtnActive.classList.add("active");
  if (_micBtnActive === $micBtn) { $micBtn.textContent = "⏺"; $micBtn.title = t("mic.stop"); }
  try { recognition.start(); }
  catch { resetMicUI(); showToast(t("toast.micStartFail")); }
}

function stopMic() {
  // ユーザーが停止をタップ。確定済みテキストは入力欄にあるので保持。
  resetMicUI();
  try { recognition && recognition.stop(); } catch {}
}

$micBtn.onclick = () => {
  if (!recognition) { showToast(t("toast.micUnsupported")); return; }
  if (micActive) stopMic();
  else startMic();
};

// ===== 🆕 新しい会話 =====
document.getElementById("newConvBtn").onclick = async () => {
  if (!selectedProject) { showToast(t("toast.selectProject")); return; }
  try { await api("/jobs/sessions/clear", "POST", { project_path: selectedProject.path }); } catch {}
  const projKey = selectedProject.id;
  sessionStorage.setItem("forceNewConv_" + projKey, "1");
  addMsg("system", t("newConv.msg"));
};

// ===== 🔒 金庫（Vault） =====
// 機密値を「この端末の localStorage に暗号化保存」し、開錠（指紋/PIN）した時だけ
// メモリに復号展開する。送信時に本文の {{名前}} に対応する値だけを secrets として
// サーバへ渡す（本文・履歴・ログには {{名前}} のまま残る）。
// 設計と不変条件は CLAUDE.md「🔒 金庫（Vault）機能」を参照。
// 自動再ロック間隔は設定値（getSettings().vaultLockMs, 5分〜7日）を使う。
const VAULT_LS_KEY = "vaultBlob_v1";   // 暗号化済み {名前:値} の保管
const VAULT_PIN_KEY = "vaultPinHash_v1";
let vaultSecrets = null;               // 開錠中だけ {名前:値}。ロック時 null
let vaultLockTimer = null;
// 開錠待ちで止まっている送信の種類: false / "send" / "interrupt"。
// 開錠成功→金庫を閉じてその送信を自動再開する。
// 開錠せず金庫を閉じたら破棄（次の開錠で古い本文が勝手に飛ぶのを防ぐ）。
let _vaultSendAfterUnlock = false;

// 🔒送信前ガード（send / interruptSend 共通）。true = 送信を止めた。
// 本文に {{名前}} があり金庫を使っている（暗号キー設定済み）のにロック中なら、
// 送信を止めて金庫を開き（指紋材料があれば指紋を自動起動）、開錠後に mode の送信を再開する。
// 金庫に無い名前は警告だけ出して送る（テンプレ文法の {{...}} を含む普通の文を
// 送れなくしない。エンジンは未知の名前を {{名前}} のまま残すので壊れない）。
// 暗号キー未設定＝金庫を使っていない人には何もしない。
function vaultGuardBlocks(text, mode) {
  if (!vaultHasPin()) return false;
  const names = ((text || "").match(/\{\{([A-Za-z0-9_\-]{1,64})\}\}/g) || []).map(m => m.slice(2, -2));
  if (!names.length) return false;
  if (vaultSecrets === null) {
    _vaultSendAfterUnlock = mode;
    showToast(t("vault.needUnlock"));
    openVault();
    return true;
  }
  const missing = names.filter(n => !(n in vaultSecrets));
  if (missing.length) showToast(t("vault.missing", { names: missing.join(", ") }));
  return false;
}

// --- PIN ハッシュ（端末内照合用。サーバには送らない） ---
async function vaultHashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vault:" + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// PBKDF2 のソルト。旧版(v1)は全端末共通の固定値だった。暗号化blob が端末外へ
// 出ると、低エントロピーな PIN の総当たりが事前計算で安価になる（固定ソルト＝
// 全インストールで同一＝レインボーテーブル可）。v2 からは保存ごとにランダムソルト
// (16B) を生成し blob に同梱する。旧blob(salt無し)はこの固定値で復号でき、次回保存
// 時に自動でランダムソルトへ移行する（後方互換）。
const _VAULT_LEGACY_SALT = new TextEncoder().encode("ai-hub-vault-salt");

// --- PIN + ソルト から AES-GCM 鍵を導出 ---
async function vaultKeyFromPin(pin, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function vaultEncrypt(obj, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));   // 保存ごとにランダム
  const key = await vaultKeyFromPin(pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))
  );
  return { v: 2, salt: [...salt], iv: [...iv], ct: [...new Uint8Array(ct)] };
}

async function vaultDecrypt(blob, pin) {
  // v2 は blob 同梱のランダムソルト。旧blob(salt無し)は固定ソルトで復号（移行猶予）。
  const salt = blob.salt ? new Uint8Array(blob.salt) : _VAULT_LEGACY_SALT;
  const key = await vaultKeyFromPin(pin, salt);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(blob.iv) }, key, new Uint8Array(blob.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

function vaultHasPin() { return !!localStorage.getItem(VAULT_PIN_KEY); }

async function vaultPersist(pin) {
  const blob = await vaultEncrypt(vaultSecrets || {}, pin);
  localStorage.setItem(VAULT_LS_KEY, JSON.stringify(blob));
}

// --- 開錠状態のタイマー（無操作/送信で再ロック） ---
function vaultResetLockTimer() {
  if (vaultLockTimer) clearTimeout(vaultLockTimer);
  if (vaultSecrets === null) return;
  const ms = getSettings().vaultLockMs;
  vaultLockTimer = setTimeout(vaultLock, ms);
  const el = document.getElementById("vaultTimer");
  if (el) el.textContent = t("vault.unlocked", { dur: fmtDuration(ms) });
}

// 期間[ms]を人が読める短い文字列に（5分/2時間/7日 …）。再ロック間隔の表示に使う。
function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return t("dur.sec", { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t("dur.min", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("dur.hour", { n: hr });
  const day = Math.round(hr / 24);
  return t("dur.day", { n: day });
}

function vaultLock() {
  vaultSecrets = null;
  if (vaultLockTimer) { clearTimeout(vaultLockTimer); vaultLockTimer = null; }
  document.getElementById("vaultUnlocked").style.display = "none";
  document.getElementById("vaultLocked").style.display = "block";
  const v = document.getElementById("vaultValue"); if (v) v.value = "";
  vaultRenderLockUI();
}

function vaultRenderLockUI() {
  // 初回（PIN 未設定）は設定欄、それ以降は入力欄を出す
  document.getElementById("vaultPinSetRow").style.display = vaultHasPin() ? "none" : "flex";
  document.getElementById("vaultPinRow").style.display = vaultHasPin() ? "flex" : "none";
  document.getElementById("vaultPinErr").style.display = "none";
}

function vaultShowUnlocked() {
  document.getElementById("vaultLocked").style.display = "none";
  document.getElementById("vaultUnlocked").style.display = "block";
  vaultRenderList();
  vaultResetLockTimer();
  vaultFetchPending();
  // 開錠待ちの送信があれば、金庫を閉じてその送信を再開する（send / ⚡割り込み）
  if (_vaultSendAfterUnlock) {
    const mode = _vaultSendAfterUnlock;
    _vaultSendAfterUnlock = false;
    closeVault();
    if (mode === "interrupt") interruptSend(); else send();
  }
}

// 🔒B方向: PC 側に溜まった受信機密（Claude が [[secret:名前]] で返した値）を
// 開錠のタイミングで取りに行き、金庫へ保存する。サーバは返した瞬間に消す
// （一回きり）ので、受け取ったら必ず即 persist する。失敗（オフライン等）は
// 静かに握りつぶす＝次の開錠でまた取りに行く。
async function vaultFetchPending() {
  try {
    const r = await api("/jobs/vault/pending");
    const s = (r && r.secrets) || {};
    const names = Object.keys(s);
    if (!names.length) return;
    vaultSecrets = Object.assign(vaultSecrets || {}, s);
    await vaultPersistCurrentPin();
    vaultRenderList();
    vaultResetLockTimer();
    showToast(t("vault.receivedStored", { n: names.length }), openVault);
  } catch {}
}

// --- 開錠した値の一覧表示（値は伏せ字、👁長押しで一時表示） ---
function vaultRenderList() {
  const $l = document.getElementById("vaultList");
  const names = Object.keys(vaultSecrets || {});
  if (!names.length) {
    $l.innerHTML = `<div style="color:var(--muted);font-size:12px;">${t("vault.empty")}</div>`;
    return;
  }
  // 名前チップ（タップで本文に {{名前}} を挿入＝記号を打たずに A方向が使える）と
  // 👁（長押しで実値）と 🗑 を分ける。チップ本体タップ＝挿入、👁＝のぞき見、🗑＝削除。
  // 値が URL のものは 🔗（タップでブラウザ起動）も出す＝値を画面に出さず・
  // コピペもせずに URL を使える（管理画面の入場URL等の受け渡し用）。
  $l.innerHTML = names.map(n => `
    <div class="vault-item" data-name="${escapeHtml(n)}">
      <button class="vinsert" title="${t("vault.insertHint")}">{{${escapeHtml(n)}}}</button>
      <span class="vval" data-reveal="0">••••••••</span>
      ${/^https?:\/\//.test(vaultSecrets[n] || "") ? `<button class="vopen" title="${t("vault.openUrl")}">🔗</button>` : ""}
      <button class="vdel" title="${t("vault.delConfirm")}">🗑</button>
    </div>`).join("");
  $l.querySelectorAll(".vault-item").forEach(item => {
    const name = item.getAttribute("data-name");
    const val = item.querySelector(".vval");
    // 名前タップ → 本文末尾に {{名前}} を挿入して金庫を閉じる。記号を発話/手打ち不要。
    item.querySelector(".vinsert").addEventListener("click", () => {
      vaultInsertPlaceholder(name);
    });
    // 🔗タップ → 値をURLとしてブラウザで開く（画面にもクリップボードにも出さない）。
    const openBtn = item.querySelector(".vopen");
    if (openBtn) openBtn.addEventListener("click", () => {
      window.open(vaultSecrets[name], "_blank");
      vaultResetLockTimer();
    });
    // 👁長押しで表示、離すと伏せ字。クリップボード経由を避ける。
    const reveal = () => { val.textContent = (vaultSecrets[name] || ""); vaultResetLockTimer(); };
    const hide = () => { val.textContent = "••••••••"; };
    val.addEventListener("touchstart", reveal); val.addEventListener("touchend", hide);
    val.addEventListener("mousedown", reveal); val.addEventListener("mouseup", hide);
    val.addEventListener("mouseleave", hide);
    item.querySelector(".vdel").addEventListener("click", async () => {
      if (!confirm(t("vault.delConfirm"))) return;
      delete vaultSecrets[name];
      await vaultPersistCurrentPin();
      vaultRenderList();
      vaultResetLockTimer();
    });
  });
}

// 本文の入力欄末尾に {{名前}} を挿入する。音声で文章を喋ったあと、🔒を開いて
// 値の名前をタップすればここが呼ばれ、記号（波括弧）を一切発話/手打ちせずに
// A方向（値を渡す）が成立する。挿入後は金庫を閉じて入力欄にフォーカス。
function vaultInsertPlaceholder(name) {
  const ph = "{{" + name + "}}";
  const cur = $instruction.value;
  // 直前が空白でなければスペースを足して読みやすく（文中挿入でもくっつかない）。
  const sep = (cur && !/\s$/.test(cur)) ? " " : "";
  $instruction.value = cur + sep + ph;
  $instruction.dispatchEvent(new Event("input"));  // 高さ自動調整等を発火
  vaultResetLockTimer();
  closeVault();
  $instruction.focus();
  showToast(t("vault.inserted", { name }));
}

// 開錠中に使った PIN を保持（再保存用）。ロックでクリア。
let _vaultActivePin = null;
async function vaultPersistCurrentPin() {
  if (_vaultActivePin) await vaultPersist(_vaultActivePin);
}
// 指紋開錠の材料は「正しい PIN を確認できた瞬間」に必ず保存/更新する。
// PIN 設定時・PIN 開錠時に呼ぶ。PIN 変更後も追従させ、古い PIN が残って
// 復号に失敗→無言で PIN 入力に落ちる事故を防ぐ。
//
// 保存形式: 旧版は PIN 平文（端末ストレージを読めれば金庫が実質無効だった）。
// 現行はランダム鍵で PIN を AES-GCM ラップした {v:2, iv, ct} を置き、鍵本体は
// PC 側（/auth/vault-key・credential 紐づけ）へ送る。鍵は WebAuthn 認証成功時の
// /auth/login/finish 応答（vault_key）でしか返らない＝指紋なしでは復号不能。
const VAULT_FP_KEY = "vaultFpUnlock_v1";
async function vaultSetFpMaterial(pin) {
  if (!pin) return;
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    await api("/auth/vault-key", "POST", { key: arrToB64u(keyBytes) });
    const k = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(pin));
    localStorage.setItem(VAULT_FP_KEY, JSON.stringify({ v: 2, iv: [...iv], ct: [...new Uint8Array(ct)] }));
  } catch {
    // サーバへ鍵を置けない（Passkey 未ログイン等）なら材料自体を残さない
    // ＝平文でも旧材料でも置かない。指紋開錠は次回 PIN 開錠時に再セットアップ。
    localStorage.removeItem(VAULT_FP_KEY);
  }
}

function openVault() {
  document.getElementById("vaultDrawer").classList.add("open");
  document.getElementById("vaultOverlay").classList.add("open");
  if (vaultSecrets === null) {
    vaultRenderLockUI();
    // 指紋材料があれば開いた瞬間に指紋認証を出す（暗証番号入力はフォールバック）。
    // openVault はタップ由来でしか呼ばれない＝ユーザー操作コンテキスト内で WebAuthn 可。
    if (vaultHasPin() && localStorage.getItem(VAULT_FP_KEY)) vaultFpUnlock();
  } else {
    vaultShowUnlocked();
  }
}
function closeVault() {
  document.getElementById("vaultDrawer").classList.remove("open");
  document.getElementById("vaultOverlay").classList.remove("open");
  _vaultSendAfterUnlock = false;   // 開錠せず閉じたら自動送信の予約は破棄
}

document.getElementById("vaultBtn").onclick = openVault;
document.getElementById("vaultClose").onclick = closeVault;
document.getElementById("vaultOverlay").addEventListener("click", closeVault);
document.getElementById("vaultLockBtn").onclick = vaultLock;

// --- PIN 設定（初回） ---
document.getElementById("vaultPinSetBtn").onclick = async () => {
  const pin = document.getElementById("vaultPinSet").value.trim();
  const err = document.getElementById("vaultPinErr");
  if (pin.length < 4) { err.textContent = t("vault.pinSet"); err.style.display = "block"; return; }
  localStorage.setItem(VAULT_PIN_KEY, await vaultHashPin(pin));
  vaultSecrets = {};
  _vaultActivePin = pin;
  await vaultPersist(pin);
  await vaultSetFpMaterial(pin);
  document.getElementById("vaultPinSet").value = "";
  vaultShowUnlocked();
};

// --- PIN で開錠 ---
document.getElementById("vaultPinBtn").onclick = async () => {
  const pin = document.getElementById("vaultPin").value.trim();
  const err = document.getElementById("vaultPinErr");
  const stored = localStorage.getItem(VAULT_PIN_KEY);
  if (!stored || await vaultHashPin(pin) !== stored) {
    err.textContent = t("vault.wrongPin"); err.style.display = "block"; return;
  }
  try {
    const raw = localStorage.getItem(VAULT_LS_KEY);
    vaultSecrets = raw ? await vaultDecrypt(JSON.parse(raw), pin) : {};
  } catch { vaultSecrets = {}; }
  _vaultActivePin = pin;
  await vaultSetFpMaterial(pin);
  document.getElementById("vaultPin").value = "";
  vaultShowUnlocked();
};

// --- 指紋で開錠（既存 Passkey を流用） ---
// 指紋 = WebAuthn 認証。成功時にサーバがラップ鍵 (vault_key) を返し、それで
// 端末内の「ラップ済み PIN」({v:2,iv,ct}) を復号 → その PIN で金庫を開ける。
// 端末ストレージだけ読めてもラップ鍵が無いので PIN は取れない。
document.getElementById("vaultFpBtn").onclick = () => vaultFpUnlock();
async function vaultFpUnlock() {
  const err = document.getElementById("vaultPinErr");
  try {
    const { session_id, options } = await api("/auth/login/begin", "POST");
    const opts = options;
    opts.challenge = b64uToArr(opts.challenge);
    if (opts.allowCredentials) opts.allowCredentials.forEach(c => c.id = b64uToArr(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const credential = {
      id: cred.id, rawId: arrToB64u(cred.rawId), type: cred.type,
      response: {
        authenticatorData: arrToB64u(cred.response.authenticatorData),
        clientDataJSON: arrToB64u(cred.response.clientDataJSON),
        signature: arrToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? arrToB64u(cred.response.userHandle) : null,
      },
    };
    const res = await api("/auth/login/finish", "POST", { session_id, credential });
    if (!res.jwt) throw new Error("no jwt");
    // 指紋成功＝本人確認OK。サーバが返したラップ鍵で端末内のラップ済み PIN を復号。
    const rawFp = localStorage.getItem(VAULT_FP_KEY);
    let pin = null;
    if (rawFp) {
      try {
        const blob = JSON.parse(rawFp);   // 旧版の平文 PIN は大抵ここで throw
        if (blob && typeof blob === "object" && blob.v === 2) {
          if (res.vault_key) {
            const k = await crypto.subtle.importKey("raw", b64uToArr(res.vault_key), "AES-GCM", false, ["decrypt"]);
            const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(blob.iv) }, k, new Uint8Array(blob.ct));
            pin = new TextDecoder().decode(pt);
          }
        } else {
          pin = rawFp;   // 数字だけの旧平文 PIN は JSON として通るのでここで拾う
        }
      } catch {
        pin = rawFp;     // JSON でない＝旧版の平文 PIN。今回だけ使い、直後にラップ形式へ移行
      }
    }
    if (pin != null) {
      try {
        const raw = localStorage.getItem(VAULT_LS_KEY);
        vaultSecrets = raw ? await vaultDecrypt(JSON.parse(raw), pin) : {};
        _vaultActivePin = pin;
        await vaultSetFpMaterial(pin);   // 旧平文→ラップ移行＋毎回鍵ローテーション
        vaultShowUnlocked();
        return;
      } catch {}
    }
    // 材料なし/復号失敗（PIN 変更後など）→ 捨てて PIN 入力へ誘導
    localStorage.removeItem(VAULT_FP_KEY);
    err.textContent = t("vault.fpNotReady"); err.style.display = "block";
  } catch (e) {
    err.textContent = t("vault.fpFail"); err.style.display = "block";
  }
}

// --- 値の追加 ---
document.getElementById("vaultAddBtn").onclick = async () => {
  if (vaultSecrets === null) return;
  const name = document.getElementById("vaultName").value.trim();
  const value = document.getElementById("vaultValue").value;
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(name) || !value) return;
  vaultSecrets[name] = value;
  await vaultPersistCurrentPin();
  // 指紋開錠材料は PIN 設定/開錠時に保存済み。保険として未設定なら今ここでも保存。
  if (_vaultActivePin && !localStorage.getItem(VAULT_FP_KEY)) vaultSetFpMaterial(_vaultActivePin);
  document.getElementById("vaultName").value = "";
  document.getElementById("vaultValue").value = "";
  vaultRenderList();
  vaultResetLockTimer();
};

// --- 金庫の値入力欄に音声入力（暗証番号・値をチャットに残さず入れる） ---
// 書き込み先を vaultValue に差し替えて録音。値はドロワー内に留まり、チャット履歴・
// ログには一切出ない（保存後は逆マスク/分離の通常経路に乗る）。
const _vaultMicBtn = document.getElementById("vaultMicBtn");
if (_vaultMicBtn) {
  if (!recognition) {
    _vaultMicBtn.style.display = "none";   // 非対応/iOS は隠す（チャット🎤と同じ判断）
  } else {
    _vaultMicBtn.onclick = () => {
      if (micActive) { stopMic(); return; }
      const $vv = document.getElementById("vaultValue");
      startMic($vv, _vaultMicBtn);
      vaultResetLockTimer();
    };
  }
}

// 本文に {{名前}} があり、その名前が開錠中の金庫にあれば secrets を組んで返す。
// 開錠していない / 該当なし → null（通常送信）。
function vaultCollectSecretsFor(text) {
  if (vaultSecrets === null || !text) return null;
  const names = (text.match(/\{\{([A-Za-z0-9_\-]{1,64})\}\}/g) || [])
    .map(m => m.slice(2, -2));
  const out = {};
  let any = false;
  for (const n of names) {
    if (n in vaultSecrets) { out[n] = vaultSecrets[n]; any = true; }
  }
  return any ? out : null;
}

// ===== 📎 添付 =====
let attachedFiles = []; // {filename, dataUrl, size}
function renderAttachBar() {
  const $b = document.getElementById("attachBar");
  if (!attachedFiles.length) { $b.style.display = "none"; $b.innerHTML = ""; return; }
  $b.style.display = "flex";
  $b.innerHTML = attachedFiles.map((f, i) => `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:5px 10px;display:flex;align-items:center;gap:6px;font-size:12px;">
      <span>📎 ${escapeHtml(f.filename)} (${Math.round(f.size/1024)}KB)</span>
      <button onclick="removeAttachment(${i})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;">×</button>
    </div>`).join("");
}
function removeAttachment(i) { attachedFiles.splice(i, 1); renderAttachBar(); }
function clearAttachments() { attachedFiles = []; renderAttachBar(); }
async function uploadAttached() {
  const out = [];
  for (const f of attachedFiles) {
    const r = await api("/uploads/", "POST", { filename: f.filename, content_base64: f.dataUrl });
    out.push(r);
  }
  return out;
}
document.getElementById("attachBtn").onclick = () => document.getElementById("attachInput").click();
document.getElementById("attachInput").addEventListener("change", async e => {
  const files = [...e.target.files];
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { showToast(t("toast.tooBig", {name: f.name})); continue; }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject; r.readAsDataURL(f);
    });
    attachedFiles.push({ filename: f.name, dataUrl, size: f.size });
  }
  e.target.value = "";
  renderAttachBar();
});

// ===== 🗂 ジョブ履歴 =====
function openJobsDrawer() {
  document.getElementById("jobsDrawer").classList.add("open");
  document.getElementById("jobsOverlay").classList.add("open");
  refreshJobs();
}
function closeJobsDrawer() {
  document.getElementById("jobsDrawer").classList.remove("open");
  document.getElementById("jobsOverlay").classList.remove("open");
}
async function refreshJobs() {
  const $l = document.getElementById("jobsList");
  $l.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("common.loading")}</div>`;
  try {
    const path = selectedProject?.path || "";
    const q = path ? `?project_path=${encodeURIComponent(path)}` : "";
    // 「終わらなかった指示」を先に取得して最上部に出す。画面を離れている間に
    // 止まった仕事をスマホで拾い、ワンタップで再開できる導線。
    let unfinishedHtml = "";
    try {
      const un = await api("/jobs/unfinished" + q);
      // running/queued は「実行中」であって中断ではない（サーバ側でも除外するが二重に防ぐ）
      const resumable = (un || []).filter(u => u.resumable && u.full_instruction
        && u.status !== "running" && u.status !== "queued");
      if (resumable.length) {
        unfinishedHtml = `<div style="font-size:11px;color:var(--muted);margin:2px 0 6px;">${t("resume.heading")}</div>` +
          resumable.map(u => {
            const when = u.created_at ? new Date(u.created_at * 1000).toLocaleTimeString() : "";
            const sec = u.needs_secret ? `<span style="font-size:10px;color:#fbbf24;">🔒 ${t("resume.needsSecret")}</span>` : "";
            return `<div class="ide-project-item" data-resume="${u.id}" style="border-left:3px solid var(--accent);">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="color:var(--accent);font-weight:600;">↻ ${t("resume.tapToResume")}</span>
                <span style="font-size:11px;color:var(--muted);">${when}</span>
              </div>
              <div style="font-size:12px;color:var(--text);margin-top:4px;">${escapeHtml((u.full_instruction || "").slice(0, 160))}</div>
              <div style="margin-top:4px;display:flex;gap:8px;align-items:center;">
                ${sec}
                <span data-dismiss="${u.id}" style="font-size:11px;color:var(--muted);text-decoration:underline;cursor:pointer;">${t("resume.dismiss")}</span>
              </div>
            </div>`;
          }).join("") +
          `<div style="height:10px;"></div>`;
      }
    } catch {}
    const jobs = await api("/jobs/" + q);
    if (!jobs.length && !unfinishedHtml) { $l.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("list.noJobs")}</div>`; return; }
    $l.innerHTML = unfinishedHtml + jobs.map(j => {
      const stColor = j.status === "running" ? "var(--accent)" : j.status === "done" ? "var(--green)" : j.status === "error" ? "var(--red)" : "var(--muted)";
      const stEmoji = j.status === "running" ? "▶" : j.status === "done" ? "✓" : j.status === "error" ? "✗" : j.status === "canceled" ? "⏹" : "…";
      const when = new Date(j.created_at * 1000).toLocaleTimeString();
      // コスト表示なし（Max/Pro プラン枠で動作・API 課金ゼロ。誤解防止）
      return `<div class="ide-project-item" data-job="${j.id}" data-status="${j.status}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:${stColor};font-weight:600;">${stEmoji} ${escapeHtml(j.engine)}</span>
          <span style="font-size:11px;color:var(--muted);">${when}</span>
        </div>
        <div style="font-size:12px;color:var(--text);margin-top:4px;">${escapeHtml(j.instruction)}</div>
        ${j.summary ? `<div style="font-size:11px;color:#a5b4fc;margin-top:4px;">💡 ${escapeHtml(j.summary)}</div>` : ""}
      </div>`;
    }).join("");
  } catch (e) { $l.innerHTML = `<div style="color:var(--red);font-size:13px;">${e.message}</div>`; }
}
document.getElementById("jobsBtn").onclick = openJobsDrawer;
document.getElementById("jobsClose").onclick = closeJobsDrawer;
document.getElementById("jobsOverlay").onclick = closeJobsDrawer;
document.getElementById("jobsList").addEventListener("click", async e => {
  // 「もういい」→ 控えを破棄して一覧から消す
  const dis = e.target.closest("[data-dismiss]");
  if (dis) {
    e.stopPropagation();
    const id = dis.dataset.dismiss;
    try { await api(`/jobs/${id}/dismiss`, "POST"); } catch {}
    refreshJobs();
    return;
  }
  // 未完了タスクの再開 → instruction を入力欄に戻すだけ（送信は人が押す）。
  // こうすると金庫A方向の {{名前}} 再注入も普通の送信経路でそのまま効く＝最も安全。
  const res = e.target.closest("[data-resume]");
  if (res) {
    const id = res.dataset.resume;
    try {
      const task = await api(`/jobs/${id}/task`);
      $instruction.value = task.instruction || "";
      closeJobsDrawer();
      $instruction.focus();
      $instruction.dispatchEvent(new Event("input"));
      if (task.needs_secret) addMsg("system", t("resume.refillSecret"));
      else addMsg("system", t("resume.restored"));
    } catch (err) { addMsg("error", err.message); }
    return;
  }
  const item = e.target.closest("[data-job]");
  if (!item) return;
  const jobId = item.dataset.job;
  closeJobsDrawer();
  if (item.dataset.status === "running") {
    // 既に接続済み（自動再接続など）なら二重ストリーム＝出力二重化になるので繋がない
    if (activeJobs.has(jobId)) { showToast(t("job.reconnect", {id: jobId})); return; }
    addMsg("system", t("job.reconnect", {id: jobId}));
    setLoading(true);
    lastJobId = jobId;
    const abort = new AbortController();
    activeJobs.set(jobId, abort);
    // jobInfo に載せないと同一プロジェクト直列化・裏ジョブバッジから漏れる
    // （この一覧は現在のプロジェクトで絞っているので selectedProject でよい）
    jobInfo.set(jobId, { projectId: selectedProject?.id || "default", projectName: selectedProject?.name || "" });
    await streamJob(jobId, 0, abort);
  } else {
    // 完了済み: 結果を一発表示
    try {
      const j = await api(`/jobs/${jobId}?include_events=true`);
      let text = "";
      const acts = [];
      const trs = [];
      for (const ev of j.events || []) {
        if (ev.type === "token") text += ev.text || "";
        else if (ev.type === "action") acts.push(ev.text);
        else if (ev.type === "tool_use") trs.push({ name: ev.name, input: ev.input, id: ev.tool_use_id });
        else if (ev.type === "tool_result") { const t = trs.find(x => x.id === ev.tool_use_id); if (t) t.result = ev.content; }
        else if (ev.type === "done") text = ev.result || text;
      }
      addMsg("system", t("job.restored", {id: jobId}));
      const el = buildAiMsgEl(text || t("job.empty"), acts, j.summary || "");
      $messages.appendChild(el); _stick = true; stickToBottom();
    } catch (e) { addMsg("error", e.message); }
  }
});

// ===== 🚀 プロセス管理 =====
let _activeProcId = null;
let _procAbort = null;
function openProcsDrawer() {
  document.getElementById("procsDrawer").classList.add("open");
  document.getElementById("procsOverlay").classList.add("open");
  refreshProcs();
}
function closeProcsDrawer() {
  if (_procAbort) { _procAbort.abort(); _procAbort = null; }
  document.getElementById("procTail").style.display = "none";
  document.getElementById("procsDrawer").classList.remove("open");
  document.getElementById("procsOverlay").classList.remove("open");
}
async function refreshProcs() {
  const $l = document.getElementById("procsList");
  try {
    const procs = await api("/processes/");
    if (!procs.length) { $l.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("list.noProcs")}</div>`; return; }
    $l.innerHTML = procs.map(p => {
      const stColor = p.status === "running" ? "var(--green)" : p.status === "stopped" ? "var(--yellow)" : "var(--muted)";
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:${stColor};font-weight:600;font-size:13px;">● ${escapeHtml(p.name)}</span>
          <span style="font-size:11px;color:var(--muted);">${p.status}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);font-family:monospace;word-break:break-all;">${escapeHtml(p.command)}</div>
        <div style="display:flex;gap:6px;">
          <button class="btn-sm" onclick="tailProc('${p.id}','${escapeHtml(p.name)}')">${t("proc.logBtn")}</button>
          ${p.status === "running" ? `<button class="btn-sm" style="color:var(--red);" onclick="stopProc('${p.id}')">${t("proc.stopBtn")}</button>` : ""}
        </div>
      </div>`;
    }).join("");
  } catch (e) { $l.innerHTML = `<div style="color:var(--red);font-size:13px;">${e.message}</div>`; }
}
async function tailProc(pid, name) {
  if (_procAbort) _procAbort.abort();
  _activeProcId = pid;
  document.getElementById("procTail").style.display = "flex";
  document.getElementById("procTailTitle").textContent = t("proc.logTitle", {name});
  const $c = document.getElementById("procTailContent");
  $c.textContent = "";
  _procAbort = new AbortController();
  const s = getSettings();
  const base = (s.url || location.origin).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/processes/${pid}/stream`, {
      headers: { "Authorization": authHeader() },
      signal: _procAbort.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === "line") {
            $c.textContent += d.text + "\n";
            $c.scrollTop = $c.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) { if (e.name !== "AbortError") $c.textContent += "\n" + t("proc.errPrefix", {msg: e.message}); }
}
async function stopProc(pid) {
  try { await api(`/processes/${pid}/stop`, "POST"); showToast(t("toast.procStopped")); await refreshProcs(); }
  catch (e) { showToast(e.message); }
}
document.getElementById("procsBtn").onclick   = openProcsDrawer;
document.getElementById("procsClose").onclick = closeProcsDrawer;
document.getElementById("procsOverlay").onclick = closeProcsDrawer;
document.getElementById("procTailClose").onclick = () => {
  if (_procAbort) { _procAbort.abort(); _procAbort = null; }
  document.getElementById("procTail").style.display = "none";
};
document.getElementById("procRunBtn").onclick = async () => {
  const cmd = document.getElementById("procCmd").value.trim();
  if (!cmd) { showToast(t("toast.enterCommand")); return; }
  if (!selectedProject) { showToast(t("toast.selectProject")); return; }
  try {
    const p = await api("/processes/run", "POST", {
      name: cmd.split(/\s+/).slice(0, 2).join(" "),
      command: cmd,
      cwd: selectedProject.path,
    });
    document.getElementById("procCmd").value = "";
    showToast(t("toast.procStarted", {name: p.name}));
    await refreshProcs();
    tailProc(p.id, p.name);
  } catch (e) { showToast(e.message); }
};

// ===== Passkey =====
function b64uToArr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function arrToB64u(a) {
  let s = ""; const b = new Uint8Array(a);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function passkeyRefreshUI() {
  const $st = document.getElementById("passkeyStatus");
  const $login = document.getElementById("passkeyLoginBtn");
  const $regPc = document.getElementById("passkeyRegisterPcBtn");
  const $add = document.getElementById("passkeyAddBtn");
  const $devs = document.getElementById("passkeyDevices");
  // 端末追加(QR発行)はローカル特権 or 有効JWTのときだけ。公開URLの未認証で出すと必ず403になる。
  const canIssue = () => isLocalOrigin() || (() => { const j = localStorage.getItem("passkeyJwt"); return j && jwtValid(j); })();
  try {
    const st = await api("/auth/status");
    const jwt = localStorage.getItem("passkeyJwt");
    const valid = jwt && jwtValid(jwt);
    const pending = sessionStorage.getItem("pendingRegisterToken");

    if (pending) {
      $st.innerHTML = t("pk.tokenReceived");
      $login.style.display = "none";
      $regPc.style.display = "";
      $add.style.display = "none";
      $devs.innerHTML = "";
      return;
    }
    if (!st.passkey_registered) {
      $st.innerHTML = t("pk.notRegistered");
      $login.style.display = "none";
      $regPc.style.display = "none";
      $add.style.display = canIssue() ? "" : "none";
      $devs.innerHTML = "";
    } else if (valid) {
      const p = jwtPayload(jwt);
      const left = Math.max(0, p.exp - Math.floor(Date.now()/1000));
      $st.innerHTML = t("pk.loggedIn", {name: escapeHtml(p.name||"?"), days: Math.floor(left/86400)});
      $login.style.display = "none";
      $regPc.style.display = "none";
      $add.style.display = "";
      // デバイス一覧
      try {
        const devs = await api("/auth/devices");
        $devs.innerHTML = devs.map(d => `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:8px 10px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13px;">📱 ${escapeHtml(d.name)} <span style="color:var(--muted);font-size:11px;">${d.id}</span></span>
            <button onclick="deleteDevice('${d.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;">${t("common.delete")}</button>
          </div>`).join("");
      } catch {}
    } else {
      $st.innerHTML = t("pk.registeredNotLoggedIn");
      $login.style.display = "";
      $regPc.style.display = "none";
      // 未ログインでは register/token を出せない（ローカルを除く）→ ローカルのみ表示。
      $add.style.display = isLocalOrigin() ? "" : "none";
      $devs.innerHTML = "";
    }
  } catch (e) {
    $st.innerHTML = `<span style="color:var(--red);">${escapeHtml(e.message)}</span>`;
  }
}

async function deleteDevice(shortId) {
  if (!confirm(t("confirm.deleteDevice", {id: shortId}))) return;
  try { await api(`/auth/devices/${shortId}`, "DELETE"); showToast(t("common.deleted")); passkeyRefreshUI(); }
  catch (e) { addMsg("error", e.message); }
}

// Passkey ログインの本体（設定ボタン / 再接続モーダルから共通で呼ぶ）。
// 成功すると JWT を保存して返す。失敗は例外を投げる（呼び元で表示）。
async function doPasskeyLogin() {
  const begin = await api("/auth/login/begin", "POST");
  const opts = begin.options;
  opts.challenge = b64uToArr(opts.challenge);
  opts.allowCredentials = (opts.allowCredentials || []).map(c => ({ ...c, id: b64uToArr(c.id) }));
  const assertion = await navigator.credentials.get({ publicKey: opts });
  const credential = {
    id: assertion.id,
    rawId: arrToB64u(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: arrToB64u(assertion.response.clientDataJSON),
      authenticatorData: arrToB64u(assertion.response.authenticatorData),
      signature: arrToB64u(assertion.response.signature),
      userHandle: assertion.response.userHandle ? arrToB64u(assertion.response.userHandle) : null,
    },
  };
  const res = await api("/auth/login/finish", "POST", { session_id: begin.session_id, credential });
  localStorage.setItem("passkeyJwt", res.jwt);
  return res;
}

document.getElementById("passkeyLoginBtn").onclick = async () => {
  try {
    const res = await doPasskeyLogin();
    showToast(t("toast.loginOk", {name: res.name || ""}));
    passkeyRefreshUI();
  } catch (e) {
    addMsg("error", t("pk.loginFail", {msg: e.message}));
  }
};

// 端末追加 QR をブラウザ内に表示する（PC ローカルで実行する想定）。
// register/token を発行 → QR 描画 → 有効期限カウントダウン。期限切れで「再発行」ボタンを出す。
let _qrCountdownTimer = null;
async function showAddDeviceQr() {
  const r = await api("/auth/register/token", "POST");
  if (!r || !r.register_url) throw new Error(t("err.commFailed"));
  const url = r.register_url;
  const $url = document.getElementById("qrUrl");
  $url.textContent = url; $url.href = url;
  const $img = document.getElementById("qrImg");
  $img.innerHTML = "";
  if (r.qr_data_uri) {
    // サーバ生成のQR画像（CDN非依存・確実）。
    const im = document.createElement("img");
    im.src = r.qr_data_uri;
    im.alt = "QR";
    im.style.cssText = "width:280px;height:280px;display:block;";
    $img.appendChild(im);
  } else if (typeof QRCode !== "undefined") {
    const canvas = document.createElement("canvas");
    $img.appendChild(canvas);
    await QRCode.toCanvas(canvas, url, { width: 280, margin: 2 });
  } else {
    // 最終フォールバック: 下のリンクをスマホで開けば登録できる。
    $img.innerHTML = `<div style="color:#333;font-size:13px;padding:8px;">${t("qr.useLink")}</div>`;
  }
  document.getElementById("qrModal").style.display = "flex";
  // カウントダウン
  if (_qrCountdownTimer) { clearInterval(_qrCountdownTimer); _qrCountdownTimer = null; }
  const $cd = document.getElementById("qrCountdown");
  const $refresh = document.getElementById("qrRefresh");
  if ($refresh) $refresh.style.display = "none";
  let left = Math.max(0, parseInt(r.expires_in_sec, 10) || 0);
  const render = () => {
    if (!$cd) return;
    if (left <= 0) {
      $cd.textContent = t("qr.expired");
      if ($refresh) $refresh.style.display = "";
      if (_qrCountdownTimer) { clearInterval(_qrCountdownTimer); _qrCountdownTimer = null; }
      return;
    }
    const m = Math.floor(left / 60), s = left % 60;
    $cd.textContent = t("qr.validFor", { time: `${m}:${String(s).padStart(2, "0")}` });
    left -= 1;
  };
  render();
  _qrCountdownTimer = setInterval(render, 1000);
}

document.getElementById("passkeyAddBtn").onclick = async () => {
  try { await showAddDeviceQr(); }
  catch (e) { addMsg("error", t("pk.runOnPc", {msg: e.message})); }
};
function closeQrModal() {
  document.getElementById("qrModal").style.display = "none";
  if (_qrCountdownTimer) { clearInterval(_qrCountdownTimer); _qrCountdownTimer = null; }
}
document.getElementById("qrCloseBtn").onclick = closeQrModal;
document.getElementById("qrRefresh").onclick = async () => {
  try { await showAddDeviceQr(); }
  catch (e) { addMsg("error", t("pk.runOnPc", {msg: e.message})); }
};

// ローカルUI（PC・管理）で passkey 未登録のとき、メイン画面上部に「スマホを追加」CTA を出す。
async function updateLocalSetupBanner(st) {
  const el = document.getElementById("localSetupBanner");
  if (!el) return;
  if (!isLocalOrigin()) { el.style.display = "none"; return; }
  // 渡されていなければ取得（基本は init から status を渡して無駄打ちを避ける）。
  if (st === undefined || st === null) {
    try { st = await api("/auth/status"); } catch { st = null; }
  }
  el.style.display = (st && !st.passkey_registered) ? "" : "none";
}
{
  const cta = document.getElementById("addDeviceCta");
  if (cta) cta.onclick = async () => {
    try { await showAddDeviceQr(); }
    catch (e) { addMsg("error", t("pk.runOnPc", {msg: e.message})); }
  };
}

// 公開URL（スマホ）で、まだ1台も登録が無いときの案内。初回登録は PC ローカルからしか
// 始められない（標準的なローカル初期設定方式）。「PCで端末追加 → カメラでQR」を一言で出す。
function showDeviceGuide() {
  if (document.getElementById("deviceGuideOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "deviceGuideOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;color:white;";
  overlay.innerHTML = `
    <div style="font-size:56px;margin-bottom:16px;">🖥️</div>
    <h2 style="font-size:21px;margin:0 0 10px;">${t("guide.title")}</h2>
    <p style="opacity:.85;margin:0 0 26px;max-width:360px;font-size:14px;line-height:1.8;">${t("guide.body")}</p>
    <button id="guideReloadBtn" style="background:#6c63ff;color:white;border:0;font-size:16px;font-weight:600;padding:16px 36px;border-radius:14px;cursor:pointer;min-width:220px;">${t("guide.reload")}</button>
  `;
  document.body.appendChild(overlay);
  document.getElementById("guideReloadBtn").onclick = () => location.reload();
}

// Passkey 登録の本体（autoStart モーダル / 設定画面ボタンから共通で呼ぶ）
async function doPasskeyRegister(tok, deviceName) {
  // 環境チェック（アプリ内ブラウザ / WebAuthn 非対応の早期検出）
  if (!window.PublicKeyCredential || !navigator.credentials || typeof navigator.credentials.create !== "function") {
    throw new Error(t("pk.unsupported"));
  }
  if (window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    const ok = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
    if (!ok) {
      throw new Error(t("pk.noBiometric"));
    }
  }
  const name = deviceName || (navigator.userAgent.match(/iPhone|iPad|Android|Mac|Windows/i)?.[0]) || t("pk.defaultDevice");
  const begin = await api("/auth/register/begin", "POST", { register_token: tok });
  const opts = begin.options;
  opts.challenge = b64uToArr(opts.challenge);
  opts.user.id = b64uToArr(opts.user.id);
  opts.excludeCredentials = (opts.excludeCredentials || []).map(c => ({ ...c, id: b64uToArr(c.id) }));
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: opts });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error(t("pk.cancelled"));
    if (e.name === "SecurityError") throw new Error(t("pk.securityErr", {msg: e.message}));
    if (e.name === "InvalidStateError") throw new Error(t("pk.alreadyReg"));
    throw new Error(`[${e.name}] ${e.message}`);
  }
  if (!cred) throw new Error(t("pk.credNull"));
  const credential = {
    id: cred.id,
    rawId: arrToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: arrToB64u(cred.response.clientDataJSON),
      attestationObject: arrToB64u(cred.response.attestationObject),
    },
  };
  const res = await api("/auth/register/finish", "POST", { session_id: begin.session_id, credential, device_name: name });
  localStorage.setItem("passkeyJwt", res.jwt);
  sessionStorage.removeItem("pendingRegisterToken");
  sessionStorage.removeItem("autoStartPasskey");
  return res;
}

document.getElementById("passkeyRegisterPcBtn").onclick = async () => {
  const tok = sessionStorage.getItem("pendingRegisterToken");
  if (!tok) { showToast(t("toast.noRegToken")); return; }
  try {
    await doPasskeyRegister(tok);
    showToast(t("pk.regDone"));
    passkeyRefreshUI();
  } catch (e) {
    addMsg("error", t("pk.regFail", {msg: e.message}));
  }
};

// ===== QR 経由のワンタップ登録モーダル =====
function showAutoRegisterModal() {
  const tok = sessionStorage.getItem("pendingRegisterToken");
  if (!tok) return;
  let overlay = document.getElementById("passkeyAutoOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "passkeyAutoOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;color:white;";
    overlay.innerHTML = `
      <div style="font-size:56px;margin-bottom:16px;">🔐</div>
      <h2 style="font-size:22px;margin:0 0 8px;">${t("pk.regTitle")}</h2>
      <p style="opacity:.7;margin:0 0 32px;max-width:320px;font-size:14px;">
        ${t("pk.autoDesc")}
      </p>
      <button id="passkeyAutoGoBtn" style="
        background:#6c63ff;color:white;border:0;font-size:17px;font-weight:600;
        padding:18px 40px;border-radius:14px;cursor:pointer;min-width:240px;
        box-shadow:0 4px 16px rgba(108,99,255,.4);">
        ${t("pk.regBtn")}
      </button>
      <button id="passkeyAutoCancelBtn" style="
        background:transparent;color:white;border:1px solid rgba(255,255,255,.3);
        font-size:14px;padding:12px 24px;border-radius:10px;margin-top:16px;cursor:pointer;">
        ${t("common.later")}
      </button>
      <div id="passkeyAutoStatus" style="margin-top:24px;font-size:13px;opacity:.7;min-height:20px;"></div>
    `;
    document.body.appendChild(overlay);
    document.getElementById("passkeyAutoGoBtn").onclick = async () => {
      const $s = document.getElementById("passkeyAutoStatus");
      const $b = document.getElementById("passkeyAutoGoBtn");
      $b.disabled = true; $b.style.opacity = ".6";
      $s.textContent = t("pk.authDialog");
      try {
        await doPasskeyRegister(tok);
        $s.innerHTML = "<span style='color:#4ade80;font-weight:600;'>" + t("pk.regComplete") + "</span>";
        setTimeout(() => { overlay.remove(); passkeyRefreshUI(); checkHealth(); loadProjects(); }, 1200);
      } catch (e) {
        $s.innerHTML = `<span style="color:#f87171;">${t("pk.autoFail", {msg: escapeHtml(e.message)})}</span><br><span style="opacity:.7;">${t("pk.autoFailHint")}</span>`;
        $b.disabled = false; $b.style.opacity = "1";
      }
    };
    document.getElementById("passkeyAutoCancelBtn").onclick = () => {
      overlay.remove();
      // pendingRegisterToken は残しておく（設定画面でも登録できるように）
    };
  }
}

// ===== 再接続用 Passkey ログインモーダル =====
// 有効な JWT が無い再接続時に出す。QR 登録のやり直しではなく、ワンタップで
// Passkey ログイン（既存資格情報で認証）して即復帰させる。WebAuthn は
// ユーザー操作が必須なので自動実行はせず、大きなボタン1つに集約する。
function showLoginModal() {
  if (document.getElementById("passkeyLoginOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "passkeyLoginOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;color:white;";
  overlay.innerHTML = `
    <div style="font-size:56px;margin-bottom:16px;">👋</div>
    <h2 style="font-size:22px;margin:0 0 8px;">${t("pk.loginTitle")}</h2>
    <p style="opacity:.7;margin:0 0 32px;max-width:320px;font-size:14px;">${t("pk.loginDesc")}</p>
    <button id="passkeyLoginGoBtn" style="
      background:#6c63ff;color:white;border:0;font-size:17px;font-weight:600;
      padding:18px 40px;border-radius:14px;cursor:pointer;min-width:240px;
      box-shadow:0 4px 16px rgba(108,99,255,.4);">
      ${t("pk.loginBtn")}
    </button>
    <div id="passkeyLoginStatus" style="margin-top:24px;font-size:13px;opacity:.85;min-height:20px;"></div>
    <button id="passkeyLoginNewBtn" style="
      background:transparent;color:white;border:1px solid rgba(255,255,255,.3);
      font-size:13px;padding:10px 20px;border-radius:10px;margin-top:20px;cursor:pointer;">
      ${t("pk.loginNewDevice")}
    </button>
  `;
  document.body.appendChild(overlay);

  const finishLogin = async () => {
    overlay.remove();
    passkeyRefreshUI();
    const ok = await checkHealth();
    if (ok) { await loadProjects(); loadConversation(); }
    if (!_healthTimerStarted) { _healthTimerStarted = true; setInterval(checkHealth, 60000); }
  };

  const runLogin = async () => {
    const $s = document.getElementById("passkeyLoginStatus");
    const $b = document.getElementById("passkeyLoginGoBtn");
    if (!$b) return;
    $b.disabled = true; $b.style.opacity = ".6";
    $s.textContent = t("pk.authDialog");
    try {
      const res = await doPasskeyLogin();
      $s.innerHTML = `<span style="color:#4ade80;font-weight:600;">${t("pk.loginOk")}${res.name ? " (" + escapeHtml(res.name) + ")" : ""}</span>`;
      setTimeout(finishLogin, 800);
    } catch (e) {
      // 自動起動が user gesture 不足やキャンセルで失敗したら、ボタンを再度押せる状態に戻す。
      $s.innerHTML = `<span style="color:#f87171;">${t("pk.loginFail", {msg: escapeHtml(e.message)})}</span>`;
      $b.disabled = false; $b.style.opacity = "1";
    }
  };

  document.getElementById("passkeyLoginGoBtn").onclick = runLogin;

  // 指紋ダイアログを即座に出す。再ログインはセッション継続中＝直前の操作の user gesture が
  // 生きていることが多いので、自動で navigator.credentials.get を叩ける。失敗（gesture 不足・
  // キャンセル）したら上の runLogin が catch してボタンを残すので、その時だけタップで再試行。
  setTimeout(runLogin, 50);
  // この端末でログインできない（パスキー未登録の別スマホ等）→ PCで端末追加する案内へ。
  // ローカルなら設定ドロワー（端末追加ボタン）を開く。
  document.getElementById("passkeyLoginNewBtn").onclick = () => {
    overlay.remove();
    if (isLocalOrigin() && typeof openDrawer === "function") { openDrawer(); passkeyRefreshUI(); }
    else showDeviceGuide();
  };
}

// ===== アプリ高さの実測固定（構造の要） =====
// body の高さを「ブラウザ任せの 100dvh」ではなく visualViewport の実測値に固定する。
// Android Chrome はキーボード表示で 100dvh の追従が不安定で、最下段ツールバーが
// overflow:hidden の body に切られて消える事故が起きていた。可視領域の実測値を
// --app-h に焼き込めば、フレックス段組みは常にその中で完結し、ツールバーは絶対に
// 画面外へ出ない。キーボード開閉・回転・アドレスバー伸縮すべてに追従する。
function syncAppHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", h + "px");
  // 入力エリアの実測高さを焼き込む。#jumpBottom（↓最新へ）をこの真上に浮かせるため。
  const ia = document.querySelector(".input-area");
  if (ia) document.documentElement.style.setProperty("--input-h", ia.offsetHeight + "px");
}
function installViewportSync() {
  syncAppHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppHeight);
    window.visualViewport.addEventListener("scroll", syncAppHeight);
  }
  window.addEventListener("resize", syncAppHeight);
  window.addEventListener("orientationchange", () => setTimeout(syncAppHeight, 200));
}

// ===== 初期化 =====
async function init() {
  installViewportSync();
  if ("serviceWorker" in navigator) {
    // sw.js もバージョン付きURLで登録 → エッジキャッシュを貫通して最新SWに更新される。
    // updateViaCache:"none" で SW スクリプト自体の取得を常にネットワーク直行にする。
    // これが無いとブラウザが sw.js を HTTP キャッシュから返し、新 CACHE_KEY の SW が
    // 永久にインストールされず古い SW が居座る（＝「更新しても変わらない」の核心）。
    // 作業中は自動更新を保留する判定。書きかけの入力・実行中ジョブ・下書きがある間は
    // 勝手にリロード（＝入力消失）させない。ここが false の安全な瞬間だけ更新を通す。
    // 理由: 書き込み中に更新が走ると打った文が消え、ユーザが打ち直す羽目になっていた。
    const isBusy = () =>
      ($instruction && $instruction.value.trim().length > 0) ||
      activeJobs.size > 0 || _loadingCount > 0 || pendingQueue.length > 0;

    let _pendingWaitingSW = null;   // installed 済みだが作業中で起動を待たせている新 SW
    let _reloaded = false;

    // 新 SW を起動→リロード。作業中なら実行せず、安全になるまで見送る。
    const applyUpdateIfIdle = () => {
      if (_reloaded) return;
      if (isBusy()) return;   // まだ作業中 → 何もしない（後の空きタイミングで再評価）
      if (_pendingWaitingSW) {
        _pendingWaitingSW.postMessage({ type: "SKIP_WAITING" });
        _pendingWaitingSW = null;
      }
    };

    navigator.serviceWorker.register("/ui/sw.js?v=" + (window.APP_VERSION || "0"), { updateViaCache: "none" }).then(reg => {
      // 新しい SW が見つかっても、作業中なら即起動させない。待たせておいて空いたら起動。
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            _pendingWaitingSW = nw;
            applyUpdateIfIdle();   // 空いていれば即、作業中なら保留
          }
        });
      });
      // 更新チェック: 定期 + PWA フォアグラウンド復帰時。取得はするが、
      // 実際の切替（リロード）は applyUpdateIfIdle が作業中でないと判断した時だけ。
      const checkUpdate = () => reg.update().catch(() => {});
      setInterval(checkUpdate, 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkUpdate();
      });
      window.addEventListener("focus", checkUpdate);
      checkUpdate();  // 起動直後にも一発
    }).catch(() => {});

    // 作業が一段落したタイミングで、保留中の更新を反映できるか毎秒見直す。
    // 入力を消した・ジョブが終わった瞬間に、待たせていた新 SW を起動する。
    setInterval(applyUpdateIfIdle, 1000);

    // controllerchange = 新 SW が active になった瞬間。一度だけリロード。
    // ここに来るのは applyUpdateIfIdle が「空いている」と判断して起動させた時だけなので、
    // 書き込み中に飛ぶことはない。念のためここでも作業中なら見送る。
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (_reloaded) return;
      if (isBusy()) return;
      _reloaded = true;
      location.reload();
    });
  }
  const { url, token } = getSettings();
  const jwt = localStorage.getItem("passkeyJwt");
  const hasJwt = jwt && jwtValid(jwt);
  const autoStartPasskey = sessionStorage.getItem("autoStartPasskey") === "1";

  // QR から来た時は、AGENT_TOKEN が無くても全画面で Passkey 登録を案内する
  if (autoStartPasskey) {
    showMain();
    updatePills();
    showAutoRegisterModal();
    return;
  }

  // UI は agent/watchdog と同一オリジンで配信されるので、URL 未設定でも api() が
  // location.origin にフォールバックする。よって URL 未設定だけで setup へ落とさない。
  const local = isLocalOrigin();

  showMain(); updatePills();
  // 通知許可の取得は await しない（fire-and-forget）。一部端末で Notification.requestPermission()
  // の Promise が解決せず永久 pending になることがあり、await すると init がここで止まって
  // statusText が初期値「確認中」のまま固着する（既知の固着原因）。await を外し、
  // ステータス表示＝checkHealth へ必ず進ませる。関数側にもタイムアウトと例外封じを持たせている。
  requestNotificationPermission();

  // 有効な JWT も token も無い＝未認証。status は1回だけ取得して使い回す（429/無駄打ち防止）。
  let _initStatus = null;
  if (!hasJwt && !token) {
    try { _initStatus = await api("/auth/status"); } catch {}
    const registered = !!(_initStatus && _initStatus.passkey_registered);
    if (!local) {
      // 公開URL（スマホ等）: 登録済みなら一発 Passkey ログイン、未登録なら QR 案内画面。
      if (registered) { showLoginModal(); return; }
      showDeviceGuide(); return;
    }
    // ローカルUI（PC・管理用）は認証なしで通す。未登録なら「📱スマホを追加」CTA を出す。
  }

  const ok = await checkHealth();
  if (ok) {
    await loadProjects();
    loadConversation();
    reattachRunningJobs();   // 画面が途中で閉じても、走行中ジョブの続きを自動で拾い直す
  }
  if (local) updateLocalSetupBanner(_initStatus);  // init で取得済みの status を再利用
  if (!_healthTimerStarted) { _healthTimerStarted = true; setInterval(checkHealth, 60000); }
}

init();

// 版数表示（設定ドロワー最下部）。「実際に読み込まれた」自分の版を自己申告する。
// index.html の期待版と食い違えばそれも見える（例: UI v112 / js v111 = 更新未達）。
(() => {
  const el = document.getElementById("appVersionInfo");
  if (el) el.textContent = "UI v" + (window.APP_VERSION || "?") + " / js v" + (window.APP_JS_VERSION || "?");
})();
