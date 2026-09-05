import { useCallback, useMemo } from "react";
import { getHitScore } from "common";
import { useAppContext } from "client";
import { getSearchPool, OrderingContext, TransactionRow } from "./sort";

/**
 * Lookup tables the transactions list orders rows against. Memoized so
 * the `hit` / `format` callbacks built on top keep a stable identity
 * across renders that don't touch the underlying data.
 */
export const useOrderingContext = (): OrderingContext => {
  const { data, calculations } = useAppContext();
  const { budgets, sections, categories, accounts, institutions, transactions } = data;
  const { transactionFamilies } = calculations;
  return useMemo(
    () => ({
      accounts,
      institutions,
      budgets,
      sections,
      categories,
      transactions,
      transactionFamilies,
    }),
    [accounts, institutions, budgets, sections, categories, transactions, transactionFamilies],
  );
};

export const useTransactionHit = (ctx: OrderingContext) => {
  const hit = useCallback(
    (searchValue: string, transaction: TransactionRow) => {
      if (!searchValue) return 0;
      const searchPool = getSearchPool(transaction, ctx);

      const search = searchValue.toLowerCase();
      const searchWords = search.split(" ");
      const totalScore = searchWords.reduce((acc, w) => {
        return acc + getHitScore(w, searchPool.join(" "));
      }, 0);

      return totalScore / searchWords.length;
    },
    [ctx],
  );
  return hit;
};
