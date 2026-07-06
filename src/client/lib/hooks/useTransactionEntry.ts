import { useCallback } from "react";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import type {
  NewTransactionGetResponse,
  NewInvestmentTransactionGetResponse,
} from "server";
import {
  Data,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  PATH,
  Transaction,
  TransactionDictionary,
  call,
  indexedDb,
} from "client";
import { useAppContext } from "./context";

/**
 * Shared entry-point for the "+ Add Transaction" and "+ Add Investment
 * Transaction" mint flows on `AccountProperties` and `HoldingProperties`.
 *
 * Consolidates the previously-duplicated per-component handlers (~90%
 * identical, called out on hoiekim/budget#588 review round 1) so the
 * mint flow is one source of truth:
 *
 *   GET  /api/new-*transaction?... → mint shell on server (source='manual')
 *   optimistic shell inserted into data.transactions / .investmentTransactions
 *   indexedDb.save(shell)
 *   router.go(PATH.TRANSACTION_DETAIL, { params: { <id> } })
 *
 * Callers pass account-level context (`account_id`, `iso_currency_code`)
 * and holding-level context (`security_id`, `price`) when available;
 * defaults fall through to the server-side createManual* helpers.
 */
export const useTransactionEntry = () => {
  const { setData, router } = useAppContext();

  /** Cash-side mint (`+ Add Transaction`, gated on manual accounts). */
  const addTransaction = useCallback(
    async (input: {
      account_id: string;
      iso_currency_code?: string | null;
    }): Promise<string | null> => {
      const query = new URLSearchParams({ account_id: input.account_id }).toString();
      const response = await call.get<NewTransactionGetResponse>("/api/new-transaction?" + query);
      if (!response.body) {
        console.error("Failed to mint new transaction:", response.message);
        return null;
      }
      const { transaction_id, name } = response.body;
      const shell = new Transaction({
        transaction_id,
        account_id: input.account_id,
        name,
        amount: 0,
        iso_currency_code: input.iso_currency_code ?? null,
        date: new Date().toISOString().split("T")[0],
        pending: false,
        source: "manual",
      });
      setData((oldData) => {
        const next = new Data(oldData);
        const dict = new TransactionDictionary(oldData.transactions);
        dict.set(transaction_id, shell);
        next.transactions = dict;
        indexedDb.save(shell).catch(console.error);
        return next;
      });
      router.go(PATH.TRANSACTION_DETAIL, {
        params: new URLSearchParams({ transaction_id }),
      });
      return transaction_id;
    },
    [setData, router.go],
  );

  /** Investment-side mint. Callable from an account with no holding context
   *  OR from a holding page carrying the primary security's context.
   *
   *  When `quantity` + `date` are also supplied (the divergence-flag
   *  reconcile flow on `HoldingProperties`), the mint lands with those
   *  values instead of the default `quantity=0 date=today`. Server derives
   *  `amount = quantity × price` at that price, so the row shows up in
   *  the tx list immediately (`TransactionsPage.filteredAndSorted`
   *  filters zero-amount rows unless `source='manual'`, per PR #601). */
  const addInvestmentTransaction = useCallback(
    async (input: {
      account_id: string;
      security_id?: string | null;
      /** Prefill from the holding's `institution_price` (holding page only).
       *  For the reconcile flow, callers should pass `priceAt(security_id,
       *  date)` — the price at the mint's OWN date, not today. */
      price?: number | null;
      /** Prefill from the holding's `iso_currency_code` (holding page only). */
      iso_currency_code?: string | null;
      /** Exact quantity to prefill (divergence reconcile). Rounded to 6dp
       *  server-side to match `numeric(15,6)` storage precision. */
      quantity?: number | null;
      /** Historical date to prefill (divergence reconcile). YYYY-MM-DD.
       *  Server ignores anything else, falling back to today. */
      date?: string | null;
    }): Promise<string | null> => {
      const params: Record<string, string> = { account_id: input.account_id };
      if (input.security_id) params.security_id = input.security_id;
      if (input.price !== undefined && input.price !== null && input.price >= 0) {
        params.price = String(input.price);
      }
      if (input.iso_currency_code) params.iso_currency_code = input.iso_currency_code;
      if (input.quantity !== undefined && input.quantity !== null && Number.isFinite(input.quantity)) {
        // Round to numeric(15,6) precision — FP subtraction of two snap
        // quantities leaves noise like 0.6232000000000539 otherwise.
        params.quantity = (Math.round(input.quantity * 1e6) / 1e6).toString();
      }
      if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        params.date = input.date;
      }

      const response = await call.get<NewInvestmentTransactionGetResponse>(
        "/api/new-investment-transaction?" + new URLSearchParams(params).toString(),
      );
      if (!response.body) {
        console.error("Failed to mint new investment transaction:", response.message);
        return null;
      }
      const { investment_transaction_id, name } = response.body;
      const shellQty =
        input.quantity !== undefined && input.quantity !== null && Number.isFinite(input.quantity)
          ? Math.round(input.quantity * 1e6) / 1e6
          : 0;
      const shellPrice = input.price ?? 0;
      const shell = new InvestmentTransaction({
        investment_transaction_id,
        account_id: input.account_id,
        security_id: input.security_id ?? null,
        date: input.date ?? new Date().toISOString().split("T")[0],
        name,
        // Mirror the server-side derivation so the optimistic shell
        // isn't filtered out of TransactionsPage's zero-amount guard
        // (PR #601). Rounded to cents.
        amount: Math.round(shellQty * shellPrice * 100) / 100,
        quantity: shellQty,
        price: shellPrice,
        iso_currency_code: input.iso_currency_code ?? null,
        type: InvestmentTransactionType.Buy,
        subtype: InvestmentTransactionSubtype.Buy,
        source: "manual",
      });
      setData((oldData) => {
        const next = new Data(oldData);
        const dict = new InvestmentTransactionDictionary(oldData.investmentTransactions);
        dict.set(investment_transaction_id, shell);
        next.investmentTransactions = dict;
        indexedDb.save(shell).catch(console.error);
        return next;
      });
      router.go(PATH.TRANSACTION_DETAIL, {
        params: new URLSearchParams({ investment_transaction_id }),
      });
      return investment_transaction_id;
    },
    [setData, router.go],
  );

  return { addTransaction, addInvestmentTransaction };
};
