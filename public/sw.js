const CACHE_NAME = "budget-v1";

self.addEventListener("install", (event) => {
  // Precache the app shell so it is available offline immediately,
  // even before the user has reloaded the page with an active SW.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add("/"))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never intercept API calls
  if (url.pathname.startsWith("/api")) return;

  // Cache-first for hashed assets (JS, CSS under /assets/)
  // Vite embeds a content hash in every filename, so the URL itself
  // changes when content changes — no stale data is ever served.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Network-first for HTML navigation so fresh index.html is always used.
  // Always store under "/" so the SPA shell is found regardless of which
  // path the user was on when they last had network access.
  if (request.mode === "navigate") {
    const responsePromise = fetch(request);

    // Use waitUntil so the SW stays alive long enough to finish writing
    // to the cache — without this, the SW can be killed mid-write.
    event.waitUntil(
      responsePromise
        .then((response) => {
          if (response.ok) {
            return caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
          }
        })
        .catch(() => {})
    );

    event.respondWith(
      responsePromise.catch(async () => {
        const cached = await caches.match("/");
        return cached ?? new Response("Offline", { status: 503 });
      })
    );
  }
});
