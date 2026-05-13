# API Patterns

## Route Definition

Routes use a custom `Route` class:

```typescript
import { Route } from "server";

export const myRoute = new Route<ResponseType>("POST", "/path", async (req, res, stream) => {
  return { status: "success", body: data };
});
```

A fourth `options` argument enables API-key bearer auth for that route — see [Authentication](#authentication).

## Response Format

All API responses follow this structure:

```typescript
interface ApiResponse<T> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}
```

| Status | Meaning |
|---|---|
| `success` | Request completed successfully |
| `failed` | Business logic failure (e.g. wrong password) |
| `error` | Server error (500) |

## Authentication

All API routes require an authenticated session by default. Authentication is enforced inside the `Bun.serve` fetch handler in `start.ts` — individual routes do **not** need to check `req.session.user`.

Public routes are explicitly allowlisted with optional method scoping:

```typescript
const PUBLIC_PATH_METHODS: [string, Set<string> | null][] = [
  ["/login", null],
  ["/plaid-hook", new Set(["POST"])],
  ["/health", new Set(["GET"])],
];
```

When adding a new public endpoint, add an entry to `PUBLIC_PATH_METHODS`. Pass `null` to allow all HTTP methods, or a `Set` to scope the exemption to specific methods. All other routes automatically return 401 if no session exists.

### Opting a route into API-key bearer auth

For routes that need to accept calls from an external client (e.g. a daily-cron LLM agent labelling transactions), pass a `requiredScope` in the `Route` options:

```typescript
export const suggestCategoryRoute = new Route<SuggestCategoryResponse>(
  "POST",
  "/suggest-category",
  async (req, res) => { /* ... */ },
  { requiredScope: "transactions:suggest" },
);
```

Behaviour:

- Cookie-session auth is still accepted (and remains more privileged).
- `Authorization: Bearer <api_key>` is consulted **only** as a fallback, and only on routes that declare a `requiredScope`. The presented key's `scopes` array must contain the declared scope.
- Bearer-authenticated requests are stateless — no session cookie is written back.

See `docs/SECURITY.md` for the full bearer-auth contract.

## Security Headers

Security response headers are set globally in `start.ts`:

- **Content-Security-Policy** — restricts script/style/image sources to `'self'`
- **X-Content-Type-Options: nosniff** — prevents MIME type sniffing
- **X-Frame-Options: DENY** — prevents clickjacking
- **X-XSS-Protection** — legacy XSS filter (defense-in-depth)
- **Referrer-Policy: strict-origin-when-cross-origin**

When adding frontend features that load external resources (fonts, images, scripts), update the CSP directives in `start.ts` rather than disabling CSP.

## Input Validation

Use validation helpers from `server/lib/validation.ts`:

```typescript
import { requireBodyObject, requireStringField, validationError } from "server";

const bodyResult = requireBodyObject(req);
if (!bodyResult.success) return validationError(bodyResult.error!);

const fieldResult = requireStringField(body, "fieldName");
if (!fieldResult.success) return validationError(fieldResult.error!);
```

- Always validate `req.body` is an object before accessing fields
- Use `requireStringField` / `requireQueryString` for required parameters
- Return structured validation errors, not raw error messages

## External API Graceful Degradation

When calling external APIs (Plaid, Polygon), handle unavailability gracefully:

- **Service not configured:** return 503 with a clear message
- **API failure:** log the error, return partial results or fallback values — don't crash the request
- **Rate limiting:** implement backoff, notify user if sync is delayed

Use discriminated unions for external API results instead of throwing:

```typescript
type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: "no_api_key" | "api_error" | "no_data"; message: string };
```

This forces callers to handle all failure modes explicitly. See `PolygonResult<T>` in `src/server/lib/polygon.ts`.

Always validate HTTP responses before parsing:

```typescript
const response = await fetch(url);
if (!response.ok) {
  return { success: false, error: "api_error", message: `HTTP ${response.status}` };
}
const data = await response.json();
```
