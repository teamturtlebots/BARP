// Bump this when you change any cached file so phones pick up the update.
const CACHE_NAME = "barp-v25";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for app shell, network-first fallback for everything else.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Audio elements frequently issue byte-range requests (Range header) to
  // support seeking. A simple full-response cache like this one doesn't
  // return proper 206 Partial Content semantics for those, which can make
  // the browser reject playback entirely ("no supported sources") even
  // though the file itself is fine. Let sound files go straight to the
  // network/browser cache, untouched by this service worker.
  if (event.request.url.includes("/sounds/")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
