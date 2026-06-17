import { useCallback, useEffect, useMemo, useState } from "react";
import { JSONTransaction } from "common";
import { MaskedUser, TransferPair, TransfersGetResponse } from "server";
import { call } from "client";

export interface ConfirmedTransfer {
  pair_id: string;
  /** Both transactions in the confirmed pair, in the order the server
   *  returned them (the bundled row renders pair[0] as the "from"
   *  side, pair[1] as the "to" side). */
  transactions: JSONTransaction[];
}

export interface Transfers {
  /**
   * transaction_id → pair_id for pairs still awaiting confirmation. A
   * transaction is present here only while its pair status is "suggested";
   * once confirmed it moves to `confirmedTransferByTransactionId`.
   */
  suggestedPairByTransactionId: Map<string, string>;
  /**
   * transaction_id → bundled confirmed-pair info. Used by
   * `TransactionsTable` to render the two paired transactions as a
   * single row (deduped on second sighting) and by
   * `TransactionProperties` to display the transfer chip + the
   * "mark as non-transfer" affordance. Both transactions in a
   * confirmed pair point at the SAME ConfirmedTransfer object.
   */
  confirmedTransferByTransactionId: Map<string, ConfirmedTransfer>;
  /** Confirm a suggested pair: status becomes "confirmed". */
  confirm: (pair_id: string) => Promise<void>;
  /** Reject a suggested pair: soft-deletes it so the row reverts. */
  reject: (pair_id: string) => Promise<void>;
  /** Unpair a confirmed pair (same delete path as reject, just
   *  semantically named for the "mark as non-transfer" affordance). */
  unpair: (pair_id: string) => Promise<void>;
}

/**
 * Transfer-pair state for the transactions UI (#354, Phase 3a). Kept separate
 * from the heavyweight cold/warm IndexedDB sync because pairs are a small,
 * cheap list refetched on demand after each confirm/reject rather than cached
 * per-month like transactions.
 */
export const useTransfers = (user: MaskedUser | undefined): Transfers => {
  const [pairs, setPairs] = useState<TransferPair[]>([]);

  const refresh = useCallback(async () => {
    const response = await call.get<TransfersGetResponse>("/api/transfers");
    if (response.status === "success" && response.body) {
      setPairs(response.body);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setPairs([]);
      return;
    }
    refresh();
  }, [user, refresh]);

  const suggestedPairByTransactionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const pair of pairs) {
      if (pair.status !== "suggested") continue;
      for (const transaction of pair.transactions) {
        map.set(transaction.transaction_id, pair.pair_id);
      }
    }
    return map;
  }, [pairs]);

  const confirmedTransferByTransactionId = useMemo(() => {
    const map = new Map<string, ConfirmedTransfer>();
    for (const pair of pairs) {
      if (pair.status !== "confirmed") continue;
      const entry: ConfirmedTransfer = {
        pair_id: pair.pair_id,
        transactions: pair.transactions,
      };
      for (const transaction of pair.transactions) {
        map.set(transaction.transaction_id, entry);
      }
    }
    return map;
  }, [pairs]);

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

  return {
    suggestedPairByTransactionId,
    confirmedTransferByTransactionId,
    confirm,
    reject,
    unpair: reject,
  };
};
