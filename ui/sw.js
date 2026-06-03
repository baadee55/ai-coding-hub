// CACHE_KEY は index.html の APP_VERSION と揃える（UI 更新時に両方上げる）。
// 新 CACHE_KEY になると activate で旧キャッシュを全削除し、確実に最新を配る。
const STATIC = ["/ui/", "/ui/index.html", "/ui/app.js", "/ui/i18n.js", "/ui/manifest.json", "/ui/icon.svg"];
const CACHE_KEY = "ai-hub-static-v59";
const API_PATTERNS = ["/command", "/projects", "/context", "/health", "/restart", "/start", "/pause", "/resume", "/shutdown", "/stream", "/jobs", "/processes", "/uploads", "/auth"];

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
