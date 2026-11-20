/* sw.js - Service Worker for the Attendance System PWA.
 *
 * Strategy:
 *   - On install: pre-cache the app shell and the CDN libraries the app
 *     needs (Font Awesome, jsPDF, jsQR). Each URL is cached independently
 *     with Promise.allSettled so that a single missing file (for example
 *     "Bg.image" when the user has not supplied one) does NOT fail the
 *     whole install.
 *   - On activate: delete any cache from a previous CACHE_VERSION.
 *   - On fetch: cache-first for same-origin GET requests and the CDN
 *     assets; fall back to the network, and on network failure fall back
 *     to the cached "./" (the app shell) so the app still opens offline.
 *
 * Bump CACHE_VERSION whenever you ship a new build of index.html so the
 * old cached shell is replaced on the next visit.
 */
const CACHE_VERSION = "AttendanceApp_v8";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./Bg.image"
];

const CDN_ASSETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.1/jspdf.plugin.autotable.min.js",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"
];

const PRECACHE = [...APP_SHELL, ...CDN_ASSETS];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Cache each URL independently: a missing local file (Bg.image) or
      // a transient CDN failure must not abort installation.
      await Promise.allSettled(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { mode: "no-cors" });
            // Only store valid responses; opaque (no-cors) responses are fine.
            if (res.ok || res.type === "opaque") {
              await cache.put(url, res.clone ? res.clone() : res);
            }
          } catch (e) {
            /* ignore individual failures */
          }
        })
      );
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET; let the browser handle POST/PUT/etc. (Firebase writes).
  if (req.method !== "GET") return;

  // Don't intercept Firebase / Google API traffic - it must hit the network.
  const url = new URL(req.url);
  const isFirebase =
    url.hostname.endsWith("firebaseio.com") ||
    url.hostname.endsWith("firebase.com") ||
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("gstatic.com") ||
    url.hostname.endsWith("firebaseapp.com");
  if (isFirebase) return;

  // Only handle http/https; let chrome-extension: and other schemes pass.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) {
        // Refresh in background (stale-while-revalidate) for non-opaque
        // responses, so the next visit has fresh content.
        if (req.mode !== "no-cors") {
          fetch(req)
            .then((fresh) => {
              if (fresh && fresh.ok) cache.put(req, fresh.clone());
            })
            .catch(() => {});
        }
        return cached;
      }
      try {
        const fresh = await fetch(req);
        // Cache successful same-origin and CDN responses.
        if (fresh.ok || fresh.type === "opaque") {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        // Network failed -> fall back to the cached app shell so the app
        // still loads offline even for a navigations to a deep URL.
        const shell = await cache.match("./");
        if (shell) return shell;
        throw err;
      }
    })()
  );
});
