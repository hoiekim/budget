import { useCallback } from "react";
import type { Recurring } from "server";
import { call, Data, RecurringDictionary, indexedDb, StoreName, useAppContext } from "client";

/**
 * Every action answers whether the server write landed. `call` turns an
 * offline tap or a parse failure into an `ApiResponse` rather than a
 * rejection, so an `await` that returns is not on its own evidence of
 * success — a caller that dismisses UI on completion needs this answer to
 * tell the two apart.
 */
export interface RecurringActions {
  /** Confirm a suggested recurring: status flips to "confirmed". Confirmed
   *  recurrings auto-attach future matching charges on detection runs. */
  confirm: (recurring_id: string) => Promise<boolean>;
  /** Dismiss a suggested recurring: server flips it to `status='dismissed'`
   *  (the row persists as the engine's per-merchant denylist signal so the
   *  same merchant group isn't re-suggested on future runs). FE removes it
   *  from the local recurrings dictionary. */
  dismiss: (recurring_id: string) => Promise<boolean>;
  /** Manually create a recurring from explicit transaction ids (the "mark
   *  as recurring" affordance). Lands directly as `status="confirmed"` —
   *  manual creation is user intent, not a suggestion. Returns the new
   *  recurring_id, or null when the server refused. */
  create: (transaction_ids: string[]) => Promise<string | null>;
}

/**
 * Recurring actions hook. Stateless: the recurring dictionary itself lives
 * on `data.recurrings`, fetched once by `useSync` alongside transfers /
 * transactions / etc. Mutation methods POST to the server then update
 * `data.recurrings` in-place via `setData` — no re-fetch, matching the
 * rest of the app's mutation pattern (see `useTransfers`).
 */
export const useRecurrings = (): RecurringActions => {
  const { setData } = useAppContext();

  const confirm = useCallback(
    async (recurring_id: string) => {
      const response = await call.post("/api/recurrings", { recurring_id });
      if (response.status !== "success") {
        if (response.message) window.alert(response.message);
        return false;
      }
      setData((oldData) => {
        const prev = oldData.recurrings.get(recurring_id);
        if (!prev) return oldData;
        const updated: Recurring = { ...prev, status: "confirmed" };
        // IDB mirror: keep the cached recurring in sync with React state
        // so the next warm boot paints with status="confirmed" instead of
        // the stale "suggested". Fire-and-forget — never await an IDB
        // write on the latency path.
        indexedDb.saveRecurring(updated).catch(console.error);
        const newData = new Data(oldData);
        newData.recurrings = new RecurringDictionary(oldData.recurrings);
        newData.recurrings.set(recurring_id, updated);
        return newData;
      });
      return true;
    },
    [setData],
  );

  const dismiss = useCallback(
    async (recurring_id: string) => {
      const response = await call.delete(
        `/api/recurrings?id=${encodeURIComponent(recurring_id)}`,
      );
      if (response.status !== "success") {
        // Dismiss is the destructive half, so a refusal has to be visible:
        // an expired session answers `status:"failed"` here, and the
        // caller's dismissal is the only other feedback this path gives.
        if (response.message) window.alert(response.message);
        return false;
      }
      setData((oldData) => {
        if (!oldData.recurrings.has(recurring_id)) return oldData;
        const newData = new Data(oldData);
        newData.recurrings = new RecurringDictionary(oldData.recurrings);
        newData.recurrings.delete(recurring_id);
        indexedDb.remove(StoreName.recurrings, recurring_id).catch(console.error);
        return newData;
      });
      return true;
    },
    [setData],
  );

  const create = useCallback(
    async (transaction_ids: string[]) => {
      const response = await call.post<{ recurring_id: string }>("/api/recurrings", {
        transaction_ids,
      });
      if (response.status !== "success" || !response.body) {
        if (response.message) window.alert(response.message);
        return null;
      }
      const { recurring_id } = response.body;
      // The new recurring arrives via the realtime `recurrings-updated`
      // event's refetch (or the next sync); no optimistic entry here —
      // unlike transfers' `pair`, we can't mint the full Recurring
      // (merchant_key/cadence/is_income are server-derived).
      return recurring_id;
    },
    [setData],
  );

  return { confirm, dismiss, create };
};
