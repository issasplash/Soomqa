// Minimal service worker for PWA installability + basic offline shell.
// Strategy: network-first for the page itself so the UI stays fresh, cache
// fallback so the app still opens on the home screen when there's no signal.

const CACHE = "soomqa-v1";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // API responses change every minute — never cache them. Same for cross-
  // origin requests; we only handle our own shell.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((cached) => cached ?? caches.match("./index.html"))),
  );
});
