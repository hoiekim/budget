import { useCallback } from "react";
import { JSONTransaction } from "common";
import { call, Data, useAppContext } from "client";

export interface ConfirmedTransfer {
  pair_id: string;
  /** Both transactions in the confirmed pair, in the order the server
   *  returned them (the bundled row renders pair[0] as the "from"
   *  side, pair[1] as the "to" side). */
  transactions: JSONTransaction[];
}

export interface TransferActions {
  /** Confirm a suggested pair: status becomes "confirmed". */
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
 * Find both transaction_ids that map to a given pair_id in one of the
 * pair maps. Used by mutation methods to update FE state in-place
 * without re-fetching.
 */
const findPairTxIds = (
  map: Map<string, unknown>,
  pair_id: string,
  matches: (entry: unknown) => boolean,
): string[] => {
  const txIds: string[] = [];
  map.forEach((entry, txId) => {
    if (matches(entry)) txIds.push(txId);
    // Stop walking once both halves found — every pair has exactly 2 sides.
  });
  return txIds;
};

/**
 * Transfer-pair actions hook (#354, Phase 3a). Stateless: the pair
 * maps themselves live on `data.suggestedPairByTransactionId` and
 * `data.confirmedTransferByTransactionId`, fetched once by `useSync`
 * alongside transactions / budgets / etc. Mutation methods POST to
 * the server then update `data` in-place via `setData` — no
 * re-fetch, matching the rest of the app's mutation pattern.
 */
export const useTransfers = (): TransferActions => {
  const { setData } = useAppContext();

  const confirm = useCallback(
    async (pair_id: string) => {
      const response = await call.post("/api/transfers/pair", { pair_id });
      if (response.status !== "success") return;
      setData((oldData) => {
        const txIds = findPairTxIds(
          oldData.suggestedPairByTransactionId,
          pair_id,
          (entry) => entry === pair_id,
        );
        // Both halves of the pair are needed to build the ConfirmedTransfer
        // entry. If only one is in `data.transactions` (rare — partial
        // sync), the second half goes in as a stub so the maps stay
        // consistent; the bundled-row renderer will skip the stub side.
        const transactions: JSONTransaction[] = txIds
          .map((id) => oldData.transactions.get(id))
          .filter((t): t is NonNullable<typeof t> => !!t);
        if (transactions.length < 2) return oldData;

        const entry: ConfirmedTransfer = { pair_id, transactions };
        const newData = new Data(oldData);
        newData.suggestedPairByTransactionId = new Map(oldData.suggestedPairByTransactionId);
        newData.confirmedTransferByTransactionId = new Map(oldData.confirmedTransferByTransactionId);
        for (const id of txIds) {
          newData.suggestedPairByTransactionId.delete(id);
          newData.confirmedTransferByTransactionId.set(id, entry);
        }
        return newData;
      });
    },
    [setData],
  );

  const reject = useCallback(
    async (pair_id: string) => {
      const response = await call.delete(`/api/transfers?id=${encodeURIComponent(pair_id)}`);
      if (response.status !== "success") return;
      setData((oldData) => {
        const newData = new Data(oldData);
        newData.suggestedPairByTransactionId = new Map(oldData.suggestedPairByTransactionId);
        newData.confirmedTransferByTransactionId = new Map(oldData.confirmedTransferByTransactionId);
        // Strip both halves from whichever map they're in. Reject is
        // semantically used on suggested pairs; unpair (same delete
        // route) is used on confirmed pairs — both paths land here.
        const suggestedTxIds = findPairTxIds(
          newData.suggestedPairByTransactionId,
          pair_id,
          (entry) => entry === pair_id,
        );
        suggestedTxIds.forEach((id) => newData.suggestedPairByTransactionId.delete(id));
        const confirmedTxIds = findPairTxIds(
          newData.confirmedTransferByTransactionId,
          pair_id,
          (entry) => (entry as ConfirmedTransfer).pair_id === pair_id,
        );
        confirmedTxIds.forEach((id) => newData.confirmedTransferByTransactionId.delete(id));
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
        const entry: ConfirmedTransfer = { pair_id, transactions: [a, b] };
        const newData = new Data(oldData);
        newData.confirmedTransferByTransactionId = new Map(oldData.confirmedTransferByTransactionId);
        newData.confirmedTransferByTransactionId.set(transaction_id_a, entry);
        newData.confirmedTransferByTransactionId.set(transaction_id_b, entry);
        return newData;
      });
    },
    [setData],
  );

  return { confirm, reject, unpair: reject, pair };
};
