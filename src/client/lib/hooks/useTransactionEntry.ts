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
    [setData, router],
  );

  /** Investment-side mint. Callable from an account with no holding context
   *  OR from a holding page carrying the primary security's context. */
  const addInvestmentTransaction = useCallback(
    async (input: {
      account_id: string;
      security_id?: string | null;
      /** Prefill from the holding's `institution_price` (holding page only). */
      price?: number | null;
      /** Prefill from the holding's `iso_currency_code` (holding page only). */
      iso_currency_code?: string | null;
    }): Promise<string | null> => {
      const params: Record<string, string> = { account_id: input.account_id };
      if (input.security_id) params.security_id = input.security_id;
      if (input.price !== undefined && input.price !== null && input.price >= 0) {
        params.price = String(input.price);
      }
      if (input.iso_currency_code) params.iso_currency_code = input.iso_currency_code;

      const response = await call.get<NewInvestmentTransactionGetResponse>(
        "/api/new-investment-transaction?" + new URLSearchParams(params).toString(),
      );
      if (!response.body) {
        console.error("Failed to mint new investment transaction:", response.message);
        return null;
      }
      const { investment_transaction_id, name } = response.body;
      const shell = new InvestmentTransaction({
        investment_transaction_id,
        account_id: input.account_id,
        security_id: input.security_id ?? null,
        date: new Date().toISOString().split("T")[0],
        name,
        amount: 0,
        quantity: 0,
        price: input.price ?? 0,
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
    [setData, router],
  );

  return { addTransaction, addInvestmentTransaction };
};
