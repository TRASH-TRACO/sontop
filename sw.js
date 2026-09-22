/* Offline shell + a long-lived cache for the ~10MB MediaPipe models, which are
 * the slowest part of a cold start. App files are network-first so a deploy is
 * picked up immediately; models and wasm are cache-first since they're versioned
 * by URL. */

const SHELL = "sontop-shell-v1";
const VENDOR = "sontop-vendor-v1";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./src/app.js",
  "./src/detector.js",
  "./src/config.js",
  "./src/styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const VENDOR_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (VENDOR_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(VENDOR).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok || res.type === "opaque") cache.put(request, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("./index.html")))
  );
});
