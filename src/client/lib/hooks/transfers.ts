import { useCallback, useEffect, useMemo, useState } from "react";
import { MaskedUser, TransferPair, TransfersGetResponse } from "server";
import { call } from "client";

export interface Transfers {
  /**
   * transaction_id → pair_id for pairs still awaiting confirmation. A
   * transaction is present here only while its pair status is "suggested";
   * once confirmed or rejected it drops out, so a row can fall back to the
   * normal budget/category controls.
   */
  suggestedPairByTransactionId: Map<string, string>;
  /** Confirm a suggested pair: status becomes "confirmed". */
  confirm: (pair_id: string) => Promise<void>;
  /** Reject a suggested pair: soft-deletes it so the row reverts. */
  reject: (pair_id: string) => Promise<void>;
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

  return { suggestedPairByTransactionId, confirm, reject };
};
