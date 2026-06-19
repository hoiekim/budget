import { useCallback } from "react";
import { JSONTransaction } from "common";
import { TransferPair, TransfersGetResponse } from "server";
import { call, Data, useAppContext } from "client";

export interface ConfirmedTransfer {
  pair_id: string;
  /** Both transactions in the confirmed pair, in the order the server
   *  returned them (the bundled row renders pair[0] as the "from"
   *  side, pair[1] as the "to" side). */
  transactions: JSONTransaction[];
}

export interface TransferActions {
  /** Re-fetch /api/transfers and write the derived maps into
   *  `data.suggestedPairByTransactionId` /
   *  `data.confirmedTransferByTransactionId`. Called on login (from
   *  `Utility`) and after every successful mutation below. */
  refresh: () => Promise<void>;
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

const buildMaps = (
  pairs: TransferPair[],
): {
  suggested: Map<string, string>;
  confirmed: Map<string, ConfirmedTransfer>;
} => {
  const suggested = new Map<string, string>();
  const confirmed = new Map<string, ConfirmedTransfer>();
  for (const pair of pairs) {
    if (pair.status === "suggested") {
      for (const transaction of pair.transactions) {
        suggested.set(transaction.transaction_id, pair.pair_id);
      }
    } else if (pair.status === "confirmed") {
      const entry: ConfirmedTransfer = {
        pair_id: pair.pair_id,
        transactions: pair.transactions,
      };
      for (const transaction of pair.transactions) {
        confirmed.set(transaction.transaction_id, entry);
      }
    }
  }
  return { suggested, confirmed };
};

/**
 * Transfer-pair actions hook (#354, Phase 3a). Stateless: the maps
 * themselves live on `data.suggestedPairByTransactionId` and
 * `data.confirmedTransferByTransactionId` — this hook just provides
 * memoized callbacks that fetch `/api/transfers` and write the
 * derived maps back via `setData`. Safe to call from any component;
 * each call returns fresh memoized callbacks but no internal state.
 *
 * Kept separate from the heavyweight cold/warm IndexedDB sync because
 * pairs are a small, cheap list refetched on demand after each
 * mutation rather than cached per-month like transactions.
 */
export const useTransfers = (): TransferActions => {
  const { setData } = useAppContext();

  const refresh = useCallback(async () => {
    const response = await call.get<TransfersGetResponse>("/api/transfers");
    if (response.status !== "success" || !response.body) return;
    const { suggested, confirmed } = buildMaps(response.body);
    setData((oldData) => {
      const newData = new Data(oldData);
      newData.suggestedPairByTransactionId = suggested;
      newData.confirmedTransferByTransactionId = confirmed;
      return newData;
    });
  }, [setData]);

  const confirm = useCallback(
    async (pair_id: string) => {
      const response = await call.post("/api/transfers/pair", { pair_id });
      if (response.status === "success") await refresh();
    },
    [refresh],
  );

  const reject = useCallback(
    async (pair_id: string) => {
      const response = await call.delete(`/api/transfers?id=${encodeURIComponent(pair_id)}`);
      if (response.status === "success") await refresh();
    },
    [refresh],
  );

  const pair = useCallback(
    async (transaction_id_a: string, transaction_id_b: string) => {
      const response = await call.post("/api/transfers/pair", {
        transaction_id_a,
        transaction_id_b,
        status: "confirmed",
      });
      if (response.status === "success") await refresh();
    },
    [refresh],
  );

  return { refresh, confirm, reject, unpair: reject, pair };
};
