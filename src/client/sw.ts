/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = "budget-v1";

sw.addEventListener("install", (event) => {
  // Precache the app shell so it is available offline immediately,
  // even before the user has reloaded the page with an active SW.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add("/"))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== sw.location.origin) return;

  // Network-first for /api/login so the app knows the auth state offline.
  if (url.pathname === "/api/login") {
    const responsePromise = fetch(request);

    event.waitUntil(
      responsePromise
        .then((response) => {
          if (!response.ok) return;
          // The Cache API silently refuses to store responses that have a
          // Set-Cookie header. Strip it before caching so the write succeeds.
          const headers = new Headers(response.headers);
          headers.delete("set-cookie");
          const cacheable = new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
          return caches.open(CACHE_NAME).then((cache) => cache.put(request, cacheable));
        })
        .catch(() => {})
    );

    event.respondWith(responsePromise.catch(() => caches.match(request) as Promise<Response>));
    return;
  }

  // Never intercept other API calls
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
