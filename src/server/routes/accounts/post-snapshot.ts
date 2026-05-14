import { JSONAccount, getSquashedDateString, JSONSnapshot, LocalDate } from "common";
import {
  Route,
  upsertSnapshots,
  requireBodyObject,
  validationError,
  getHoldingsByAccount,
} from "server";
import { logger } from "server/lib/logger";

export interface SnapshotPostResponse {
  snapshot_id: string;
}

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
    if (!("snapshot" in body)) {
      return validationError("Request body must contain snapshot data");
    }

    // TODO: Snapshot can be holding or security snapshot as well
    const account: JSONAccount = body.account as JSONAccount;

    // Block historical-balance edits when the account has holdings — the
    // account total should reconcile against `Σ(holdings)` + cash, so a
    // direct balances.current write would diverge from the holdings view
    // for that date. Same rule as `post-account.ts`.
    if (account?.account_id && account?.balances && "current" in account.balances) {
      const holdings = await getHoldingsByAccount(user, account.account_id);
      if (holdings.length > 0) {
        return validationError(
          "Account total snapshot cannot be edited directly when holdings exist. Update the cash row in Holdings Composition instead.",
        );
      }
    }
    const snapshotData = body.snapshot as Record<string, unknown>;
    const date = snapshotData.date ? new LocalDate(snapshotData.date as string) : new Date();
    const snapshot: JSONSnapshot = {
      snapshot_id: `${account.account_id}-${getSquashedDateString(date)}`,
      date: date.toISOString(),
    };

    const { user_id } = user;
    const newSnapshot = { user: { user_id }, snapshot, account };

    try {
      const response = await upsertSnapshots([newSnapshot]);
      const snapshot_id = response[0].update?._id || "";
      return { status: "success", body: { snapshot_id } };
    } catch (error: unknown) {
      logger.error("Failed to update snapshot", { snapshotId: snapshot.snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
