import { useCallback } from "react";
import type { JSONRecurringLabel } from "common";
import type { Recurring, RecurringPostResponse } from "server";
import {
  call,
  Data,
  RecurringDictionary,
  Transaction,
  TransactionDictionary,
  indexedDb,
  StoreName,
  useAppContext,
} from "client";

/**
 * Every action answers whether the server write landed. `call` turns an
 * offline tap or a parse failure into an `ApiResponse` rather than a
 * rejection, so an `await` that returns is not on its own evidence of
 * success — a caller that dismisses UI on completion needs this answer to
 * tell the two apart.
 */
export interface RecurringActions {
  /** Confirm a suggested recurring: status flips to "confirmed" and its
   *  transactions take its default label (seeded from their own labels when
   *  it has none). Confirmed recurrings auto-attach future matching charges
   *  on detection runs. */
  confirm: (recurring_id: string) => Promise<boolean>;
  /** Dismiss a suggested recurring: server flips it to `status='dismissed'`
   *  (the row persists as the engine's per-merchant denylist signal so the
   *  same merchant group isn't re-suggested on future runs). FE removes it
   *  from the local recurrings dictionary. */
  dismiss: (recurring_id: string) => Promise<boolean>;
  /** Manually create a recurring from explicit transaction ids (the "mark
   *  as recurring" affordance). Lands directly as `status="confirmed"` —
   *  manual creation is user intent, not a suggestion. An optional
   *  display name overrides the server-derived merchant name. Returns the
   *  new recurring_id, or null when the server refused. */
  create: (transaction_ids: string[], merchant_name?: string) => Promise<string | null>;
  /** Add transactions to an existing recurring (the detail page's "add to
   *  recurring" affordance). Returns true when the server write landed. */
  addTo: (recurring_id: string, transaction_ids: string[]) => Promise<boolean>;
  /** Rename a recurring. The name is display-only, so it applies locally
   *  as soon as the server accepts it. */
  rename: (recurring_id: string, merchant_name: string) => Promise<boolean>;
  /** Set a recurring's default budget/category. While it's confirmed, its
   *  transactions follow, except ones labeled differently from the old
   *  default. */
  setLabel: (recurring_id: string, label: JSONRecurringLabel) => Promise<boolean>;
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

  // Writes that can relabel transactions answer with the recurring as the
  // server now has it, members' labels included. The writing tab filters its
  // own realtime event out, so applying that answer is the only way this tab
  // sees its write before the next sync.
  const apply = useCallback(
    (recurring: Recurring) => {
      indexedDb.saveRecurring(recurring).catch(console.error);
      setData((oldData) => {
        const newData = new Data(oldData);
        newData.recurrings = new RecurringDictionary(oldData.recurrings);
        newData.recurrings.set(recurring.recurring_id, recurring);
        let transactions: TransactionDictionary | undefined;
        recurring.transactions.forEach(({ transaction_id, label }) => {
          const existing = oldData.transactions.get(transaction_id);
          if (!existing || !label) return;
          if (
            existing.label.budget_id === label.budget_id &&
            existing.label.category_id === label.category_id &&
            existing.label.category_confidence === label.category_confidence
          ) {
            return;
          }
          const updated = new Transaction(existing);
          updated.label.budget_id = label.budget_id;
          updated.label.category_id = label.category_id;
          updated.label.category_confidence = label.category_confidence;
          indexedDb.save(updated).catch(console.error);
          transactions ??= new TransactionDictionary(oldData.transactions);
          transactions.set(transaction_id, updated);
        });
        if (transactions) newData.transactions = transactions;
        return newData;
      });
    },
    [setData],
  );

  const confirm = useCallback(
    async (recurring_id: string) => {
      const response = await call.post<RecurringPostResponse>("/api/recurrings", {
        recurring_id,
      });
      if (response.status !== "success") {
        if (response.message) window.alert(response.message);
        return false;
      }
      const recurring = response.body?.recurring;
      if (recurring) {
        apply(recurring);
        return true;
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
    [apply, setData],
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
    async (transaction_ids: string[], merchant_name?: string) => {
      const response = await call.post<RecurringPostResponse>("/api/recurrings", {
        transaction_ids,
        ...(merchant_name ? { merchant_name } : {}),
      });
      if (response.status !== "success" || !response.body) {
        if (response.message) window.alert(response.message);
        return null;
      }
      const { recurring_id, recurring } = response.body;
      if (recurring) apply(recurring);
      return recurring_id;
    },
    [apply],
  );

  const addTo = useCallback(
    async (recurring_id: string, transaction_ids: string[]) => {
      const response = await call.post<RecurringPostResponse>("/api/recurrings", {
        recurring_id,
        transaction_ids,
      });
      if (response.status !== "success") {
        if (response.message) window.alert(response.message);
        return false;
      }
      const recurring = response.body?.recurring;
      if (recurring) apply(recurring);
      return true;
    },
    [apply],
  );

  const rename = useCallback(
    async (recurring_id: string, merchant_name: string) => {
      const response = await call.post("/api/recurrings", { recurring_id, merchant_name });
      if (response.status !== "success") {
        if (response.message) window.alert(response.message);
        return false;
      }
      setData((oldData) => {
        const prev = oldData.recurrings.get(recurring_id);
        if (!prev) return oldData;
        const updated: Recurring = { ...prev, merchant_name };
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

  const setLabel = useCallback(
    async (recurring_id: string, label: JSONRecurringLabel) => {
      const response = await call.post<RecurringPostResponse>("/api/recurrings", {
        recurring_id,
        label,
      });
      if (response.status !== "success") {
        if (response.message) window.alert(response.message);
        return false;
      }
      const recurring = response.body?.recurring;
      if (recurring) apply(recurring);
      return true;
    },
    [apply],
  );

  return { confirm, dismiss, create, addTo, rename, setLabel };
};
