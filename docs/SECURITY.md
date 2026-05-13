# Security

## Centralized Authentication

Authentication is enforced inside the `Bun.serve` fetch handler in `src/server/start.ts`, not per-route. All API endpoints require an authenticated session by default.

```typescript
const PUBLIC_PATH_METHODS: [string, Set<string> | null][] = [
  ["/login", null],
  ["/plaid-hook", new Set(["POST"])],
  ["/health", new Set(["GET"])],
];

// inside Bun.serve fetch():
const entry = PUBLIC_PATH_METHODS.find(([p]) => p === apiPath);
const isPublic = !!entry && (!entry[1] || entry[1].has(request.method));
if (!isPublic && !session.user) {
  return jsonResponse({ status: "failed", message: "Not authenticated." }, 401);
}
```

- New routes are protected automatically — no per-route auth checks needed
- To make a route public, add an entry to `PUBLIC_PATH_METHODS`. The second tuple element scopes the exemption to specific HTTP methods (`null` means all methods)
- Public routes must have external verification (e.g., `/plaid-hook` verifies Plaid signatures)

### API-Key Bearer Auth (opt-in)

Cookie sessions are the privileged default. A route may additionally accept `Authorization: Bearer <api_key>` by declaring a `requiredScope` in its `Route` options:

```typescript
new Route<MyResponse>(
  "POST",
  "/my-path",
  async (req, res) => { /* ... */ },
  { requiredScope: "transactions:suggest" },
);
```

Rules enforced in `start.ts`:

- Bearer auth is only attempted when the matched route declares a `requiredScope`, and only as a fallback when no cookie session is present.
- The presented key must verify (via `verifyApiKey`) **and** its `scopes` array must contain the route's `requiredScope`.
- Bearer-authenticated requests are stateless — `_bearer` is flagged on the session so `persistSession` skips writing a session cookie back.

Keys are minted in the UI ("API Keys" section on the Config page) and shown plaintext once at creation. Storage is SHA-256 hex with a `UNIQUE` index; verification uses indexed lookup + `timingSafeEqual`. Keys carry `name`, `key_prefix`, `scopes[]`, `created_at`, `last_used_at`, `revoked_at`, `expires_at`. Revocation is a one-way bit; revoked keys fail `verifyApiKey`.

## Session Fixation Prevention

On successful login, the session ID is regenerated to prevent session fixation attacks:

```typescript
await new Promise<void>((resolve, reject) => {
  req.session.regenerate((err) => {
    if (err) reject(err);
    else resolve();
  });
});
req.session.user = maskedUser;
```

## Anti-Enumeration on Login

Login endpoints must not reveal whether a username exists.

**Always run the password comparison even when the user is not found**, using a pre-computed dummy hash to prevent timing attacks:

```typescript
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const pwMatches = user
  ? await bcrypt.compare(password, user.password)
  : await bcrypt.compare(password, DUMMY_HASH).then(() => false);
```

Always return the same generic error message regardless of failure reason:

```typescript
// Good — same message for both cases
return { status: "failed", message: "Invalid username or password." };

// Bad — reveals whether username exists
return { status: "failed", message: "User is not found." };
return { status: "failed", message: "Wrong password." };
```

## Resource Ownership Verification

**Every delete/update route must verify the resource belongs to the authenticated user.**

Repository-level `softDelete` by primary key alone is NOT sufficient:

```typescript
// Dangerous — deletes any user's resource
await snapshotsTable.softDelete(snapshot_id);

// Safe — verify ownership first
const snapshot = await searchSnapshots(user, { snapshot_id });
if (!snapshot) return { status: "failed", message: "Not found" };
await snapshotsTable.softDelete(snapshot_id);

// Better — scope the delete query itself by user_id
await pool.query(
  "UPDATE snapshots SET is_deleted = TRUE WHERE snapshot_id = $1 AND user_id = $2",
  [snapshot_id, user.user_id]
);
```
