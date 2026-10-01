// CACHE_KEY は index.html の APP_VERSION と揃える（UI 更新時に両方上げる）。
// 新 CACHE_KEY になると activate で旧キャッシュを全削除し、確実に最新を配る。
// app.js / i18n.js は ?v= 付きで要求される（cache.match はクエリ込み一致）ため、
// プリキャッシュも同じ ?v= 付き URL で焼く。素の URL で焼くと永久にヒットせず
// 「インストール直後にオフラインで開くと白画面」になる。v は sw.js?v=NN の自分の URL から取る。
const V = new URL(self.location.href).searchParams.get("v") || "0";
const STATIC = ["/ui/", "/ui/index.html", `/ui/app.js?v=${V}`, `/ui/i18n.js?v=${V}`, "/ui/manifest.json", "/ui/icon-192.png", "/ui/icon-512.png", "/ui/apple-touch-icon.png"];
const CACHE_KEY = "ai-hub-static-v115";
const API_PATTERNS = ["/command", "/projects", "/context", "/health", "/restart", "/start", "/pause", "/resume", "/shutdown", "/stream", "/jobs", "/processes", "/uploads", "/auth", "/push"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_KEY).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE_KEY).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

// ===== Web Push =====
// アプリを閉じていても・スマホがスリープでも、サーバ(PC)からの完了通知をOS通知で出す。
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    // アプリが前面で見えているなら OS 通知は出さない（画面内のローカル通知と二重になるため）
    try {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === "visible")) return;
    } catch {}
    await self.registration.showNotification(d.title || "AI hub", {
      body: d.body || "",
      tag: d.tag || "aihub",
      icon: "/ui/icon-192.png",
      badge: "/ui/icon-192.png",
      data: { url: d.url || "/ui/" },
    });
  })());
});

// 通知タップ → 開いているタブがあればフォーカス、無ければ開く
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) return w.focus();
    }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/ui/");
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API リクエストはキャッシュしない（ネットワーク直行）
  if (API_PATTERNS.some((p) => url.pathname.includes(p))) return;

  // 静的アセットは network-first（必ず最新を取りに行く → 修正が即反映される）。
  // オフライン時だけキャッシュにフォールバックする。
  if (url.pathname.startsWith("/ui/")) {
    e.respondWith(
      caches.open(CACHE_KEY).then(async (cache) => {
        try {
          // cache:"no-store" でブラウザ HTTP キャッシュ層を必ず素通りして
          // オリジン（CF→agent）まで取りに行く。これを付けないと SW の network-first が
          // 間に挟まる HTTP キャッシュで古い mic-dictation.js を掴まされ、それを SW
          // キャッシュへ焼き直して「更新しても変わらない」状態が固着する。
          const res = await fetch(e.request, { cache: "no-store" });
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        } catch {
          const cached = await cache.match(e.request);
          return cached || Response.error();
        }
      })
    );
  }
});
