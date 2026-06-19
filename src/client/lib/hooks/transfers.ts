import { useCallback } from "react";
import type { TransferPair } from "server";
import { call, Data, TransferDictionary, indexedDb, StoreName, useAppContext } from "client";

export interface TransferActions {
  /** Confirm a suggested pair: status flips to "confirmed". */
  confirm: (pair_id: string) => Promise<void>;
  /** Reject a suggested pair: soft-deletes it so the row reverts. */
  reject: (pair_id: string) => Promise<void>;
  /** Unpair a confirmed pair (same delete path as reject, just
   *  semantically named for the "mark as non-transfer" affordance). */
  unpair: (pair_id: string) => Promise<void>;
  /** Manually pair two transactions as a confirmed transfer. Used by
   *  the "Mark as Transfer" affordance for cases where (a) the user
   *  accidentally unpaired and wants to undo later, or (b) the
   *  detect-transfers heuristic missed the pair. Lands directly as
   *  `status="confirmed"` — manual pairing is user intent, not a
   *  suggestion. */
  pair: (transaction_id_a: string, transaction_id_b: string) => Promise<void>;
}

/**
 * Transfer-pair actions hook (#354, Phase 3a). Stateless: the pair
 * dictionary itself lives on `data.transfers`, fetched once by
 * `useSync` alongside transactions / budgets / etc. Mutation methods
 * POST to the server then update `data.transfers` in-place via
 * `setData` — no re-fetch, matching the rest of the app's mutation
 * pattern.
 */
export const useTransfers = (): TransferActions => {
  const { setData } = useAppContext();

  const confirm = useCallback(
    async (pair_id: string) => {
      const response = await call.post("/api/transfers/pair", { pair_id });
      if (response.status !== "success") return;
      setData((oldData) => {
        const prev = oldData.transfers.get(pair_id);
        if (!prev) return oldData;
        const updatedPair: TransferPair = { ...prev, status: "confirmed" };
        // IDB mirror: keep the cached pair in sync with React state so
        // the next warm boot paints with status="confirmed" instead of
        // the stale "suggested" from the prior cold sync. Fire-and-forget
        // — never await an IDB write on the latency path.
        indexedDb.saveTransfer(updatedPair).catch(console.error);
        const newData = new Data(oldData);
        newData.transfers = new TransferDictionary(oldData.transfers);
        newData.transfers.set(pair_id, updatedPair);
        return newData;
      });
    },
    [setData],
  );

  const reject = useCallback(
    async (pair_id: string) => {
      const response = await call.delete(`/api/transfers?id=${encodeURIComponent(pair_id)}`);
      if (response.status !== "success") return;
      indexedDb.remove(StoreName.transfers, pair_id).catch(console.error);
      setData((oldData) => {
        if (!oldData.transfers.has(pair_id)) return oldData;
        const newData = new Data(oldData);
        newData.transfers = new TransferDictionary(oldData.transfers);
        newData.transfers.delete(pair_id);
        return newData;
      });
    },
    [setData],
  );

  const pair = useCallback(
    async (transaction_id_a: string, transaction_id_b: string) => {
      const response = await call.post<{ pair_id: string }>("/api/transfers/pair", {
        transaction_id_a,
        transaction_id_b,
        status: "confirmed",
      });
      if (response.status !== "success" || !response.body) return;
      const { pair_id } = response.body;
      setData((oldData) => {
        const a = oldData.transactions.get(transaction_id_a);
        const b = oldData.transactions.get(transaction_id_b);
        if (!a || !b) return oldData;
        const newPair: TransferPair = {
          pair_id,
          status: "confirmed",
          transactions: [a, b],
        };
        indexedDb.saveTransfer(newPair).catch(console.error);
        const newData = new Data(oldData);
        newData.transfers = new TransferDictionary(oldData.transfers);
        newData.transfers.set(pair_id, newPair);
        return newData;
      });
    },
    [setData],
  );

  return { confirm, reject, unpair: reject, pair };
};
