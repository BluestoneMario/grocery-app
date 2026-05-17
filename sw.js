/* Market List — service worker
 *
 * Strategy:
 *   - App shell (HTML, icons, manifest):   stale-while-revalidate
 *   - Cross-origin (Google Fonts):         stale-while-revalidate, persistent cache
 *   - Everything else same-origin:         cache-first with network fallback
 *
 * Bump APP_VERSION whenever any cached file changes so old caches are deleted
 * and clients pick up new assets on next activate.
 */

const APP_VERSION = '1.6.1';
const STATIC_CACHE = `marketlist-static-${APP_VERSION}`;
const FONTS_CACHE  = `marketlist-fonts-${APP_VERSION}`;

const SHELL_URLS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/favicon-32.png',
];

// ── INSTALL ─────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Add individually so a single 404 doesn't fail the whole install
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] precache failed:', url, err);
          })
        )
      )
    )
  );
});

// ── ACTIVATE ────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== FONTS_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ── MESSAGES (from app) ─────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        if (event.source) {
          event.source.postMessage({ type: 'CACHES_CLEARED' });
        }
      })()
    );
    return;
  }

  if (data.type === 'GET_VERSION') {
    if (event.source) {
      event.source.postMessage({ type: 'VERSION', version: APP_VERSION });
    }
  }
});

// ── HELPERS ─────────────────────────────────────────────────────────
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    const networkPromise = fetch(request)
      .then((response) => {
        if (response && response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => null);

    return cached || (await networkPromise) || new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  });
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      return new Response('Offline', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });
}

// ── FETCH ──────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Skip non-http(s) requests (chrome-extension://, data:, etc.)
  if (!url.protocol.startsWith('http')) return;

  // Google Fonts — stale-while-revalidate, separate persistent cache
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONTS_CACHE));
    return;
  }

  // Navigation requests (the user opens the PWA / reloads) — stale-while-revalidate
  // so users don't wait on the network on cold start, but still get updates next launch.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('./'));
        const networkPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put('./index.html', res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await networkPromise) || new Response('Offline', { status: 503 });
      })()
    );
    return;
  }

  // Same-origin static assets — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Anything else (third-party API calls etc.) — pass through
});
