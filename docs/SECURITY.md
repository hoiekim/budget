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
- While single sign-on is on, `ssoPublicPathMethods()` (`src/server/lib/sso/state.ts`) adds `GET /auth/login`, `GET /auth/callback` and `POST /auth/events`. While it is off they are not public, and answer exactly like unknown routes (401 anonymous, 404 signed in)

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
- With single sign-on on, a key `verifyApiKey` does not know is checked with the identity provider's introspection endpoint instead (`resolveIntrospectedKey` in `src/server/lib/bearer-auth.ts`). It authenticates only when the provider answers active, its `scopes` contain the route's `requiredScope`, and its owner's `sub` is linked to a local user. A provider that can't be reached answers `503`, not `401`.

Keys are minted in the UI ("API Keys" section on the Config page) and shown plaintext once at creation. Storage is SHA-256 hex with a `UNIQUE` index; verification uses indexed lookup + `timingSafeEqual`. Keys carry `name`, `key_prefix`, `scopes[]`, `created_at`, `last_used_at`, `revoked_at`, `expires_at`. Revocation is a one-way bit; revoked keys fail `verifyApiKey`.

## Single Sign-On

Optional, and off unless `AUTH_ISSUER` is set; the README's "Single sign-on (optional)" section is the operator's guide. The pieces:

- **Configuration** is parsed and checked at boot (`src/server/lib/sso/config.ts`); a bad value stops the start with every problem listed. Nothing contacts the identity provider at boot.
- **The client** is `src/server/lib/auth-client.ts`, vendored byte for byte from the auth project. Do not edit it; copy a new version over it.
- **Sign-in** (`src/server/routes/auth/`): `/auth/login` redirects to the provider with a short-lived `__Host-login` cookie; `/auth/callback` verifies the answer, finds, links or creates the local user (`src/server/lib/sso/users.ts`), and starts the app's ordinary `session_id` session, with the provider's `sid`, refresh token and next re-check time in the row's `auth_*` columns. Every failure sends the browser back to `/login?sso_error=<reason>` (`SsoError` in `src/common/constants.ts`). The callback's query, which carries a one-time code, is kept out of the access log.
- **Linking** never guesses: a username held by an unlinked account (`admin` and `demo` included) is refused, and `AUTH_LINK_USERS` is the only way to link an existing account. Writes are race-safe: the link is an `UPDATE … WHERE auth_sub IS NULL`, and the create is an `INSERT … ON CONFLICT DO NOTHING` followed by a re-read.
- **Re-check (pull).** `recheckSession` in `src/server/lib/session.ts` refreshes a session's sign-in with the provider once its `auth_recheck_at` has passed, at most once at a time per session. `invalid_grant` ends the session. An unreachable provider leaves it served until an hour past its re-check. A session whose re-check is not due costs no query beyond the session read every request already makes. Once single sign-on is turned off, a session it started ends at its next request.
- **Events (push).** `POST /auth/events` verifies the provider's security event token and `handleAuthEvent` (`src/server/lib/sso/events.ts`) deletes the sessions it names and closes this process's event streams for them. Each handler is idempotent, since delivery is at least once. Other copies of the app find out within a minute: with single sign-on on, every `/events` stream re-reads its session every 60 s (`watchSession`) and closes once the session is gone.
- **Writes after an event.** With single sign-on on, a request writes back a session it read with an `UPDATE` rather than an upsert (`saveSession`), so a session an event deleted mid-request stays deleted.
- **Password sign-in** answers `403` unless `AUTH_LOCAL_LOGIN` is true. Users created by single sign-on have no password, and an account linked to the provider signs in only through it, so both fail password sign-in the same way an unknown user does. A provider-side disable therefore can't be undone with a local password.
- **Access-ending events** (`access.changed` with no role, `user.disabled`, `user.deleted`) also revoke the API keys budget itself issued to the account, which never ask the provider. Giving access back doesn't restore them.

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
  ? await verifyPassword(password, user.password)
  : await verifyPassword(password, DUMMY_HASH).then(() => false);
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

// Better — scope the delete itself by user_id, through the Table method
// (`Table.softDelete` takes the owner id; see
// `repositories/snapshots.ts` `deleteSnapshotById`), so the ownership check
// lives in the write itself without raw SQL — matching DATABASE.md's
// "Use `Table` class methods instead of direct SQL/pool operations".
await snapshotsTable.softDelete(snapshot_id, user.user_id);
```
