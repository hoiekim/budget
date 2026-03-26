// Docker healthcheck: verifies both the API and the static frontend are reachable.
// The API check catches database/server failures; the root check catches missing
// static file serving (e.g. NODE_ENV guard not firing, build output missing).
const BASE = "http://localhost:" + (process.env.PORT || 3005);

async function check(path, opts = {}) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(path + " returned " + res.status);
  if (opts.contentType) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes(opts.contentType))
      throw new Error(path + " content-type was " + ct);
  }
}

try {
  await check("/api/health");
  await check("/", { contentType: "text/html" });
  process.exit(0);
} catch (e) {
  console.error("Healthcheck failed:", e.message);
  process.exit(1);
}
