// このファイルが想定するアプリ版数。index.html の APP_VERSION と必ず一致させる
// （UI を変えてバージョンを上げるときは index.html / sw.js / ここの3点を同じ数字に）。
// index.html 側の自己修復ガードが、この値と window.APP_VERSION の不一致を検出したら
// 古い SW を unregister して取り直す。＝SW が壊れていても必ず最新へ収束する保険。
window.APP_JS_VERSION = "65";

// ===== 設定 =====
// 実行エンジンは Claude Code に一本化（Maxプラン枠で動作）。
function getSettings() {
  return {
    url:            (localStorage.getItem("agentUrl") || "").replace(/\/+$/, ""),
    token:          localStorage.getItem("token") || "",
    engine:         "claude_code",
    ccModel:        localStorage.getItem("ccModel") || "",
    permMode:       localStorage.getItem("permMode") || "bypassPermissions",
    vscodeName:     localStorage.getItem("vscodeTunnelName") || "aihub-pc",
  };
}
function saveSettings(opts) {
  if (opts.url !== undefined)        localStorage.setItem("agentUrl", opts.url.replace(/\/+$/, ""));
  if (opts.token !== undefined)      localStorage.setItem("token", opts.token);
  if (opts.ccModel !== undefined)    localStorage.setItem("ccModel", opts.ccModel);
  if (opts.permMode !== undefined)   localStorage.setItem("permMode", opts.permMode);
  if (opts.vscodeName !== undefined) localStorage.setItem("vscodeTunnelName", opts.vscodeName);
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
function jwtValid(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    return (payload.exp || 0) > Math.floor(Date.now() / 1000);
  } catch { return false; }
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
    return await _handleApiResponse(res);
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
const ADHOC_KEY = Symbol("adhoc");   // 📋状況/📅まとめ等の非ジョブ系処理用キー
let lastJobId = null;                // 中断ボタンと再接続が対象にする最新ジョブ
let _loadingCount = 0;
let _interrupting = false;   // ⚡割り込み中フラグ（中断メッセージの二重表示を抑制）
let isPaused = false;
let currentAbortController = null;
// 実行中に追加送信された指示の待ち行列。現ジョブ完了後に同じセッションで続けて実行する。
let pendingQueue = [];

// ===== DOM =====
const $setup       = document.getElementById("setupScreen");
const $main        = document.getElementById("mainScreen");
const $messages    = document.getElementById("messages");
const $instruction = document.getElementById("instruction");
const $sendBtn     = document.getElementById("sendBtn");
const $micBtn      = document.getElementById("micBtn");
const $statusDot   = document.getElementById("statusDot");
const $statusText  = document.getElementById("statusText");
const $projSelect  = document.getElementById("projectSelect");

// ===== セットアップ =====
function showSetup() { $setup.style.display = "flex"; $main.style.display = "none"; }
function showMain()  { $setup.style.display = "none";  $main.style.display = "flex"; }

document.getElementById("setupSaveBtn").onclick = async () => {
  const url   = document.getElementById("setupUrl").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("setupToken").value.trim();
  if (!url || !token) { alert(t("toast.enterUrlToken")); return; }
  saveSettings({ url, token });
  showMain(); await init();
};

// ===== ヘルスチェック =====
// /health の fetch が一瞬落ちただけで「切断」に倒すと、ステータスドットが
// チカチカし、送信前チェックも無駄に弾く。瞬断を吸収するため軽くリトライする。
async function _fetchHealth() {
  const { url } = getSettings();
  const base = (url || location.origin).replace(/\/+$/, "");
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(15000) });
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await _sleep(600);  // 1回だけ間を置いて再試行
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
      projects.map(p => `<option value="${p.id}" data-path="${p.path}">${p.name}</option>`).join("");
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
function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
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

// ===== AI メッセージ要素 =====
function buildAiMsgEl(text, actions, summary) {
  const d = document.createElement("div");
  d.className = "msg msg-ai";
  const textEl = document.createElement("div");
  textEl.innerHTML = renderMarkdown(text);
  d.appendChild(textEl);
  // コードブロックごとに右上へ📋を差す。pre 内の <code> 全文をコピー（行番号や装飾は含まない）。
  textEl.querySelectorAll("pre").forEach(pre => {
    const codeEl = pre.querySelector("code");
    if (!codeEl) return;
    const cb = document.createElement("button");
    cb.className = "code-copy-btn"; cb.textContent = "📋"; cb.title = t("copy.code");
    cb.onclick = () => copyText(codeEl.textContent, cb);
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
  ttsBtn.onclick = () => {
    if (ttsBtn.classList.contains("speaking")) { speechSynthesis.cancel(); ttsBtn.classList.remove("speaking"); return; }
    speak(text, ttsBtn);
  };
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn"; copyBtn.textContent = "📋"; copyBtn.title = t("copy.title");
  copyBtn.onclick = () => copyText(text, copyBtn);
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
  }
  $messages.appendChild(d);
  $messages.scrollTop = $messages.scrollHeight;
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
    $messages.appendChild(d); $messages.scrollTop = $messages.scrollHeight;
  } else {
    // アイドルに戻ったら、待ち行列の追加指示を続けて実行する
    maybeRunNext();
  }
}

// ===== ジョブ実行（jobs API + SSE、再接続可能、並列実行可） =====

async function send() {
  const text = $instruction.value.trim();
  if (!text && !attachedFiles.length) return;
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

  // 🔒金庫A方向: 本文に {{名前}} があり開錠中の金庫に値があれば secrets を組む。
  // 本文（addMsg 済み・履歴・ログ）には {{名前}} のまま残り、値はここで集めて
  // payload にだけ載せる（サーバが一時ファイル書込み直前に注入）。
  const vaultSecretsForSend = vaultCollectSecretsFor(finalText);
  if (vaultSecretsForSend) vaultLock();  // 送信したら即再ロック（不変条件4）

  // すでに実行中なら「今の作業に追加」: 並列の別ジョブを立てず、
  // 待ち行列に積んで、現ジョブ完了後に同じセッションで続けて実行する。
  if (_loadingCount > 0 || activeJobs.size > 0) {
    pendingQueue.push({ text: finalText, secrets: vaultSecretsForSend });
    addMsg("system", t("queue.added", {n: pendingQueue.length}));
    return;
  }
  await runJob(finalText, vaultSecretsForSend);
}

// 待ち行列に積まれた追加指示を、実行中ジョブが無くなったら順に実行する。
function maybeRunNext() {
  if (!pendingQueue.length) return;
  if (_loadingCount > 0 || activeJobs.size > 0) return;
  const next = pendingQueue.shift();
  // 旧形式（文字列）と新形式（{text, secrets}）の両対応
  if (typeof next === "string") runJob(next);
  else runJob(next.text, next.secrets);
}

// ⚡ 今すぐ割り込み: 実行中の生成を止めて、新しい指示で即立て直す。
// 会話(セッション)は切らない＝ new_session:false の resume なので文脈は保持される。
// 既存の待ち行列はクリアせず、この指示を先頭に差し込んで最優先で実行する。
async function interruptSend() {
  const text = $instruction.value.trim();
  if (!text && !attachedFiles.length) { showToast(t("toast.typeFirst")); return; }
  // 実行中でなければ通常送信と同じ
  if (_loadingCount === 0 && activeJobs.size === 0) { return send(); }
  pulseSendBtn();
  pushHistory(text);
  const finalText = text;   // 割り込みはテキスト指示のみ（添付は通常送信で）
  addMsg("user", finalText);
  $instruction.value = ""; $instruction.style.height = "auto";
  addMsg("system", t("interrupt.switching"));
  pendingQueue.unshift(finalText);   // 先頭に差し込む＝中断後に必ずこれが走る
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

async function runJob(instruction, secrets) {
  setLoading(true);
  _interrupting = false;   // 新ジョブ開始＝割り込み処理は完了
  document.getElementById("typingDot")?.remove();
  const abort = new AbortController();

  const s = getSettings();
  const base = (s.url || location.origin).replace(/\/+$/, "");
  const projKey = selectedProject?.id || "default";
  const startNew = sessionStorage.getItem("forceNewConv_" + projKey) === "1";
  sessionStorage.removeItem("forceNewConv_" + projKey);

  const payload = {
    engine: "claude_code",
    instruction,
    project_path: selectedProject?.path || null,
    new_session: startNew,
    permission_mode: s.permMode,
  };
  if (s.ccModel) payload.model = s.ccModel;
  // 🔒金庫A方向: 該当する {{名前}} の実値だけを secrets として送る。
  // サーバは job/events/ログには入れず、一時ファイル書込み直前にだけ注入する。
  if (secrets) payload.secrets = secrets;

  let job;
  try {
    job = await api("/jobs/", "POST", payload);
  } catch (e) {
    addMsg("error", e.message);
    setLoading(false);
    return;
  }
  lastJobId = job.id;
  activeJobs.set(job.id, abort);
  localStorage.setItem("lastJobId_" + projKey, job.id);

  await streamJob(job.id, /* fromSeq */ 0, abort);
}

async function streamJob(jobId, fromSeq, abort, attempt = 0) {
  // 並列実行対応: abort は呼び出し側から渡されるのが基本。
  // 未指定なら新規に作成して登録（再接続用パスのフォールバック）。
  if (!abort) {
    abort = new AbortController();
    activeJobs.set(jobId, abort);
  }
  const s = getSettings();
  const base = (s.url || location.origin).replace(/\/+$/, "");
  const aiDiv = document.createElement("div");
  aiDiv.className = "msg msg-ai"; $messages.appendChild(aiDiv);

  let rawText = "";
  const actions = [];
  const toolResults = [];
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
  $messages.scrollTop = $messages.scrollHeight;

  function finish() {
    if (settled) return;
    settled = true;
    clearInterval(liveTimer);
    activeJobs.delete(jobId);
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
      setConnBar(null);
      addMsg("error", t("conn.notRecovered"));
      finish();
      return;
    }
    const delay = Math.min(800 * Math.pow(1.7, nextAttempt), 12000);
    // 通知は fixed の帯（#connBar）だけに出す。#messages に積むと最後の行として
    // 入力欄の上に居座り、画面が短い時にツールバーを押し出す原因になっていた。
    setConnBar(t("status.reconnecting"), false);
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
    $messages.scrollTop = $messages.scrollHeight;
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
          addMsg("error", d.text || t("stream.errOccurred"));
          finish(); return;
        } else if (d.type === "canceled") {
          if (!_interrupting) addMsg("system", t("stream.aborted"));
          aiDiv.remove();
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
        const vis = body.style.display === "none";
        body.style.display = vis ? "block" : "none";
        btn.textContent = vis ? t("tools.hide") : t("tools.show", {n: toolResults.length});
      };
      tr.appendChild(btn); tr.appendChild(body); finalEl.appendChild(tr);
    }
    // 💰 コスト・⏱時間・🔁ターン数は一切表示しない。Max/Pro プラン枠で動き API 課金は
    // 発生しないため（main.py 起動ガード + claude_code.py が ANTHROPIC_API_KEY を除去）、
    // コスト表示は課金の誤解を生むだけ。時間・ターン数もユーザーに不要なので出さない。
    $messages.appendChild(finalEl);
    // 🔒金庫B方向: Claude が [[secret:名前]] で機密を返したら、サーバは実値を分離して
    // 件数だけ vault_received で知らせる。本文には [[secret:名前]] プレースホルダだけ残る。
    // 値そのものは SSE で流さない（漏洩面を作らない）方針。受信通知だけ出す。
    if (doneData?.vault_received > 0) {
      addMsg("system", t("vault.received", { n: doneData.vault_received }));
    }
    $messages.scrollTop = $messages.scrollHeight;
    notifyComplete(doneData?.summary || "");
    saveConversation();
  } catch (e) {
    if (e.name === "AbortError") {
      aiDiv.remove();
      if (!_interrupting) addMsg("system", t("stream.disconnected"));
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
      const r = await api("/context/summary?project_path=" + encodeURIComponent(selectedProject.path));
      addMsg("ai", r.summary);
    } catch(e) { addMsg("error", e.message); }
    finally { setLoading(false); }
  }, 300);
};
document.getElementById("dailyBtn").onclick = async () => {
  if (!selectedProject) { addMsg("system", t("toast.selectProject")); return; }
  setLoading(true);
  try {
    const r = await api("/context/daily?project_path=" + encodeURIComponent(selectedProject.path));
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
  if (e.key === "ArrowDown" && !e.shiftKey) {
    e.preventDefault(); _histIdx = Math.max(_histIdx - 1, -1);
    $instruction.value = _histIdx >= 0 ? _hist[_histIdx] : "";
  }
}, true);

// ===== 会話履歴永続化 =====
function saveConversation() {
  const key = "conv_" + (selectedProject?.id || "default");
  const msgs = [...$messages.children].filter(el => !el.id).map(el => ({ cls: el.className, html: el.innerHTML })).slice(-80);
  localStorage.setItem(key, JSON.stringify(msgs));
}
function loadConversation() {
  $messages.innerHTML = "";
  const key = "conv_" + (selectedProject?.id || "default");
  const msgs = JSON.parse(localStorage.getItem(key) || "[]");
  if (msgs.length === 0) { renderWelcome(); return; }
  msgs.forEach(m => {
    const d = document.createElement("div"); d.className = m.cls; d.innerHTML = m.html; $messages.appendChild(d);
  });
  $messages.scrollTop = $messages.scrollHeight;
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

// ===== モデル切替（Claude Code のみ） =====
function updatePills() {
  const s = getSettings();
  const $mp = document.getElementById("modelPill");
  if (!$mp) return;
  $mp.style.display = s.ccModel ? "" : "none";
  if (s.ccModel) $mp.textContent = s.ccModel.charAt(0).toUpperCase() + s.ccModel.slice(1);
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
// 後方互換
function updateModelPill() { updatePills(); }

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
  if (!("Notification" in window) || Notification.permission !== "default") return;
  await Notification.requestPermission();
}
function notifyComplete(summary) {
  if (!("Notification" in window)) return;   // iOS Safari 非PWA 等。未ガードだと完了時に投げ→誤再接続
  if (document.visibilityState !== "hidden" || Notification.permission !== "granted") return;
  new Notification(t("notif.title"), { body: summary || t("notif.body"), icon: "/ui/icon.svg" });
}

// ===== ユーティリティ =====
function showToast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
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

// ===== 設定ドロワー =====
function openDrawer() {
  const s = getSettings();
  document.getElementById("drawerUrl").value        = s.url;
  document.getElementById("drawerCcModel").value    = s.ccModel;
  document.getElementById("drawerPermMode").value   = s.permMode;
  document.getElementById("drawerVscodeName").value = s.vscodeName;
  updateAuthStatusLine();
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
      const p = JSON.parse(atob(jwt.split(".")[1]));
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
document.getElementById("drawerSave").onclick = async () => {
  saveSettings({
    url:        document.getElementById("drawerUrl").value.trim(),
    ccModel:    document.getElementById("drawerCcModel").value,
    permMode:   document.getElementById("drawerPermMode").value,
    vscodeName: document.getElementById("drawerVscodeName").value.trim(),
  });
  closeDrawer(); updatePills(); await checkHealth(); await loadProjects();
};

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
      model_override: "sonnet",   // 中継（一覧取得）は Sonnet。作業（指示実行）だけ Opus。
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
const VAULT_LOCK_MS = 60000;          // 無操作 60 秒で自動ロック
const VAULT_LS_KEY = "vaultBlob_v1";   // 暗号化済み {名前:値} の保管
const VAULT_PIN_KEY = "vaultPinHash_v1";
let vaultSecrets = null;               // 開錠中だけ {名前:値}。ロック時 null
let vaultLockTimer = null;

// --- PIN ハッシュ（端末内照合用。サーバには送らない） ---
async function vaultHashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vault:" + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- PIN から AES-GCM 鍵を導出 ---
async function vaultKeyFromPin(pin) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("ai-hub-vault-salt"), iterations: 100000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function vaultEncrypt(obj, pin) {
  const key = await vaultKeyFromPin(pin);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))
  );
  return { iv: [...iv], ct: [...new Uint8Array(ct)] };
}

async function vaultDecrypt(blob, pin) {
  const key = await vaultKeyFromPin(pin);
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
  vaultLockTimer = setTimeout(vaultLock, VAULT_LOCK_MS);
  const sec = Math.round(VAULT_LOCK_MS / 1000);
  const el = document.getElementById("vaultTimer");
  if (el) el.textContent = t("vault.unlocked", { sec });
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
  $l.innerHTML = names.map(n => `
    <div class="vault-item" data-name="${escapeHtml(n)}">
      <button class="vinsert" title="${t("vault.insertHint")}">{{${escapeHtml(n)}}}</button>
      <span class="vval" data-reveal="0">••••••••</span>
      <button class="vdel" title="${t("vault.delConfirm")}">🗑</button>
    </div>`).join("");
  $l.querySelectorAll(".vault-item").forEach(item => {
    const name = item.getAttribute("data-name");
    const val = item.querySelector(".vval");
    // 名前タップ → 本文末尾に {{名前}} を挿入して金庫を閉じる。記号を発話/手打ち不要。
    item.querySelector(".vinsert").addEventListener("click", () => {
      vaultInsertPlaceholder(name);
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
const VAULT_FP_KEY = "vaultFpUnlock_v1";
function vaultSetFpMaterial(pin) {
  if (pin) localStorage.setItem(VAULT_FP_KEY, pin);
}

function openVault() {
  document.getElementById("vaultDrawer").classList.add("open");
  document.getElementById("vaultOverlay").classList.add("open");
  if (vaultSecrets === null) vaultRenderLockUI();
  else vaultShowUnlocked();
}
function closeVault() {
  document.getElementById("vaultDrawer").classList.remove("open");
  document.getElementById("vaultOverlay").classList.remove("open");
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
  vaultSetFpMaterial(pin);
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
  vaultSetFpMaterial(pin);
  document.getElementById("vaultPin").value = "";
  vaultShowUnlocked();
};

// --- 指紋で開錠（既存 Passkey を流用。生体で本人確認→PIN を解錠キーに使う） ---
// 指紋は「本人確認」に使い、復号鍵自体は端末に保存した PIN ラップキーを使う方式。
// 簡潔に: 指紋成功 → 保存済み PIN ハッシュに紐づくラップ済み PIN で復号。
// ここでは指紋成功時に、PIN 入力なしで開錠できるよう端末内に PIN を WebAuthn 後のみ
// 触れる形にはせず、実用上は「指紋で本人確認 → 直近 PIN セッションを復元」とする。
document.getElementById("vaultFpBtn").onclick = async () => {
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
    // 指紋成功＝本人確認OK。端末に「指紋ラップ済み解錠材料」を置いておき、それで復号。
    const wrapped = localStorage.getItem(VAULT_FP_KEY);
    if (wrapped) {
      try {
        const raw = localStorage.getItem(VAULT_LS_KEY);
        vaultSecrets = raw ? await vaultDecrypt(JSON.parse(raw), wrapped) : {};
        _vaultActivePin = wrapped;
        vaultShowUnlocked();
        return;
      } catch {
        // 復号失敗＝保存材料が古い（PIN 変更後など）。捨てて PIN 入力へ誘導。
        localStorage.removeItem(VAULT_FP_KEY);
      }
    }
    // 指紋ラップ材料が未設定/失効 → PIN 入力にフォールバック
    err.textContent = t("vault.fpNotReady"); err.style.display = "block";
  } catch (e) {
    err.textContent = t("vault.fpFail"); err.style.display = "block";
  }
};

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
    const jobs = await api("/jobs/" + (path ? `?project_path=${encodeURIComponent(path)}` : ""));
    if (!jobs.length) { $l.innerHTML = `<div style="color:var(--muted);font-size:13px;">${t("list.noJobs")}</div>`; return; }
    $l.innerHTML = jobs.map(j => {
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
  const item = e.target.closest("[data-job]");
  if (!item) return;
  const jobId = item.dataset.job;
  closeJobsDrawer();
  if (item.dataset.status === "running") {
    addMsg("system", t("job.reconnect", {id: jobId}));
    setLoading(true);
    lastJobId = jobId;
    const abort = new AbortController();
    activeJobs.set(jobId, abort);
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
      $messages.appendChild(el); $messages.scrollTop = $messages.scrollHeight;
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
      $add.style.display = "";
      $devs.innerHTML = "";
    } else if (valid) {
      const p = JSON.parse(atob(jwt.split(".")[1]));
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
      $add.style.display = "";
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

document.getElementById("passkeyLoginBtn").onclick = async () => {
  try {
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
    showToast(t("toast.loginOk", {name: res.name || ""}));
    passkeyRefreshUI();
  } catch (e) {
    addMsg("error", t("pk.loginFail", {msg: e.message}));
  }
};

document.getElementById("passkeyAddBtn").onclick = async () => {
  try {
    const r = await api("/auth/register/token", "POST");
    const url = r.register_url;
    document.getElementById("qrUrl").textContent = url;
    const canvas = document.createElement("canvas");
    document.getElementById("qrImg").innerHTML = ""; document.getElementById("qrImg").appendChild(canvas);
    await QRCode.toCanvas(canvas, url, { width: 280, margin: 2 });
    document.getElementById("qrModal").style.display = "flex";
  } catch (e) {
    addMsg("error", t("pk.runOnPc", {msg: e.message}));
  }
};

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
    navigator.serviceWorker.register("/ui/sw.js?v=" + (window.APP_VERSION || "0"), { updateViaCache: "none" }).then(reg => {
      // 新しい SW が見つかったら即座に切り替えてリロード
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            // 既存 SW がある状態で新 SW が installed → 待機中。即起動させる
            nw.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      // 更新チェック: 定期 + PWA フォアグラウンド復帰時。
      // バックグラウンドから戻った瞬間に新しい SW を取りに行くので、
      // ユーザは「触ったら勝手に最新になってる」体験になる。
      const checkUpdate = () => reg.update().catch(() => {});
      setInterval(checkUpdate, 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkUpdate();
      });
      window.addEventListener("focus", checkUpdate);
      checkUpdate();  // 起動直後にも一発
    }).catch(() => {});
    // controllerchange = 新 SW が active になった瞬間。一度だけリロード
    let _reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (_reloaded) return;
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

  // 認証情報が一つもないなら setup 画面
  if (!url || (!token && !hasJwt)) { showSetup(); return; }

  showMain(); updatePills();
  await requestNotificationPermission();
  const ok = await checkHealth();
  if (ok) {
    await loadProjects();
    loadConversation();
  }
  setInterval(checkHealth, 60000);
}

init();
