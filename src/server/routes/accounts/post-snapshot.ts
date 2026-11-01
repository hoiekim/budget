import { JSONAccount, getSquashedDateString, JSONSnapshot } from "common";
import {
  Route,
  upsertSnapshots,
  requireBodyObject,
  optionalDateField,
  validateFields,
  validationError,
  getAccount,
} from "server";
import type { FieldSpec } from "server";
import { logger } from "server/lib/logger";

export interface SnapshotPostResponse {
  snapshot_id: string;
  /** The date actually persisted, as an ISO string. The id and the stored date
   *  are both derived from the server's local midnight, so a client that echoed
   *  its own `new LocalDate(input)` into the cache would disagree with the next
   *  sync whenever the browser and the server sit in different zones. */
  date: string;
}

/**
 * The typed fields an account snapshot can carry, mirroring their columns
 * in `models/snapshot.ts` (BALANCES_AVAILABLE / CURRENT / LIMIT
 * DECIMAL(15, 2), BALANCES_ISO_CURRENCY_CODE VARCHAR(10)). All four are
 * nullable, so an explicit null clears the column rather than failing.
 * Runs BEFORE the ownership lookup, matching #776: a client type error is
 * a `failed` answer with the field named, never a 22P02 at the write that
 * `Route.execute` turns into a 500 plus an alarm. `account.balances`
 * itself is optional — absent leaves nothing to check, and the write side
 * defaults each balance to null. Overflow stays out of scope here (see
 * #880, which adds the range bound to `FieldSpec` for all swept routes).
 */
const SNAPSHOT_BODY_SPEC: FieldSpec[] = [
  { path: "account.balances.available", type: "number", nullable: true },
  { path: "account.balances.current", type: "number", nullable: true },
  { path: "account.balances.limit", type: "number", nullable: true },
  { path: "account.balances.iso_currency_code", type: "string", nullable: true },
];

export const postSnapshotRoute = new Route<SnapshotPostResponse>(
  "POST",
  "/snapshot",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data as Record<string, unknown>;
    const snapshotData = body.snapshot;
    if (!snapshotData || typeof snapshotData !== "object" || Array.isArray(snapshotData)) {
      return validationError("Request body must contain snapshot data");
    }

    // TODO: Snapshot can be holding or security snapshot as well
    const account = body.account as JSONAccount | undefined;
    if (!account || typeof account !== "object" || typeof account.account_id !== "string") {
      return validationError("Request body must contain an account with an account_id");
    }

    const fieldsResult = validateFields(body, SNAPSHOT_BODY_SPEC);
    if (!fieldsResult.success) return validationError(fieldsResult.error!);

    if (!(await getAccount(user, account.account_id))) {
      return { status: "failed", message: "Account not found or access denied." };
    }

    const parsedDate = optionalDateField(
      snapshotData as Record<string, unknown>,
      "date",
      "snapshot.date",
    );
    if (!parsedDate.success) return validationError(parsedDate.error!);
    const date = parsedDate.data ?? new Date();
    const snapshot: JSONSnapshot = {
      snapshot_id: `${account.account_id}-${getSquashedDateString(date)}`,
      date: date.toISOString(),
    };

    const { user_id } = user;
    const newSnapshot = { user: { user_id }, snapshot, account };

    try {
      const response = await upsertSnapshots([newSnapshot]);
      const snapshot_id = response[0].update?._id || "";
      return { status: "success", body: { snapshot_id, date: snapshot.date } };
    } catch (error: unknown) {
      logger.error("Failed to update snapshot", { snapshotId: snapshot.snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
