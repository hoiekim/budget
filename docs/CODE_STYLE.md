# Code Style

## Module Imports

**Always import from the highest module alias** (`common`, `server`, or `client`). Do not use relative import paths.

```typescript
// Good
import { Account, useAppContext, GraphInput } from "client";
import { LocalDate, ViewDate } from "common";
import { pgGetUsers } from "server";

// Bad
import { Account } from "../../models/Account";
import { useAppContext } from "../context";
```

## TypeScript

- Avoid `any` — use proper types or `unknown` with type guards
- Use explicit return types for exported functions
- Prefer interfaces over type aliases for objects

## Error Handling

Server routes catch errors and return 500:

```typescript
try {
  // route logic
} catch (error: any) {
  console.error(error);
  res.status(500).json({ status: "error", info: error?.message });
}
```

**Don't swallow errors with `.catch(console.error)`.** This pattern silently hides failures:

```typescript
// Bad — error is logged but not propagated
await doSomething().catch(console.error);

// Good — log and re-throw
await doSomething().catch((error) => {
  console.error("Operation failed:", error);
  throw error;
});

// Good — let caller handle it
await doSomething();
```

This is especially important in scheduled tasks where failures need to be tracked.

## Structured Logging

**Use the logger module instead of `console.*` methods.**

```typescript
import { logger } from "server/lib/logger";

logger.info("Sync completed", { userId: user.id, itemCount: 42 });
logger.warn("Rate limit approaching", { endpoint: "/api/sync", remaining: 5 });
logger.error("Sync failed", { userId: user.id }, error);
logger.debug("Processing item", { itemId, data });
```

| Environment | Output |
|---|---|
| Production | JSON for log aggregators |
| Development | Human-readable colored output |
| Test | Silent by default (set `LOG_LEVEL=debug` to enable) |

Log levels: `debug` < `info` < `warn` < `error`. Set minimum with `LOG_LEVEL` env var.

## Time Constants

Use named constants from `common/utils/date.ts`:

```typescript
import { ONE_HOUR, TWO_WEEKS, THIRTY_DAYS } from "common";
```

## Accessibility

### Interactive Elements

Use semantic HTML for interactive elements:

```tsx
// Bad — not keyboard-accessible
<div className="AccountRow" onClick={onClickAccount}>

// Good
<button className="AccountRow" onClick={onClickAccount}>

// Acceptable when button styling is impractical
<div role="button" tabIndex={0} onClick={onClickAccount}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClickAccount(); }}>
```

### Form Inputs

Every `<input>` must have an associated label:

```tsx
// Explicit label
<label htmlFor="budget-name">Budget Name</label>
<input id="budget-name" value={name} onChange={onChange} />

// aria-label when visual label exists nearby
<input aria-label="Budget capacity amount" value={amount} onChange={onChange} />
```

## Timer Cleanup in React

Every `setTimeout`/`setInterval` in a `useEffect` must be cleaned up on unmount:

```tsx
// Bad — timer fires after unmount
useEffect(() => {
  const id = setTimeout(() => setSomething(true), 500);
}, [dep]);

// Good
useEffect(() => {
  const id = setTimeout(() => setSomething(true), 500);
  return () => clearTimeout(id);
}, [dep]);
```

For recursive polling patterns, use a cancellation flag:

```tsx
useEffect(() => {
  let cancelled = false;
  const poll = () => {
    if (cancelled) return;
    if (!ref.current) { setTimeout(poll, 100); return; }
    // ... use ref
  };
  const id = setTimeout(poll, 100);
  return () => { cancelled = true; clearTimeout(id); };
}, [deps]);
```
