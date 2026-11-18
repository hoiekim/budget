import type { AuthEvent } from "server/lib/auth-client";
import { closeSubscribers } from "server/lib/realtime";
import { getUserByAuthSub } from "server/lib/postgres/repositories/users";
import {
  deleteSessionsByAuthSid,
  deleteSessionsByUserId,
} from "server/lib/postgres/repositories/session";

/** Event types after which a person may no longer use the app at all. */
const ACCESS_ENDING_EVENTS = new Set(["user.disabled", "user.deleted"]);

/**
 * Applies a verified security event. The identity provider delivers each
 * event at least once, and every branch here is idempotent — deleting what is
 * already gone deletes nothing — so no record of handled `jti`s is kept.
 *
 * Budget has no roles: any role is access, so `access.changed` matters only
 * when access is removed. `user.deleted` keeps the user's data.
 * `credential.revoked` needs nothing here: `readEvent` already dropped the
 * key's cached introspection answer, and no connection is held by a key.
 * Other copies of the app notice deleted sessions through their own 60-second
 * re-check of each open event stream.
 */
export const handleAuthEvent = async (event: AuthEvent): Promise<void> => {
  if (event.type === "session.ended" && event.sid !== undefined) {
    await deleteSessionsByAuthSid(event.sid);
    closeSubscribers({ authSid: event.sid });
    return;
  }

  const endsAccess =
    ACCESS_ENDING_EVENTS.has(event.type) || (event.type === "access.changed" && event.role === null);
  if (!endsAccess || event.sub === undefined) return;

  const user = await getUserByAuthSub(event.sub);
  if (!user) return;
  await deleteSessionsByUserId(user.user_id);
  closeSubscribers({ userId: user.user_id });
};
