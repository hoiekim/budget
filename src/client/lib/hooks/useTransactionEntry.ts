import { useCallback } from "react";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import type { NewTransactionGetResponse, NewInvestmentTransactionGetResponse } from "server";
import { normalizeShareMovement } from "common";
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
 * The query a mint is asked with, and the row the caller will show for it.
 *
 * The type is decided here, once, and sent: the mint stores what it is
 * given, and the copy shown immediately is built from the same return, so
 * neither has to work the direction out for itself.
 */
export const mintInvestmentTransactionRequest = (input: {
  account_id: string;
  security_id?: string | null;
  price?: number | null;
  iso_currency_code?: string | null;
  quantity?: number | null;
  date?: string | null;
}) => {
  const params: Record<string, string> = { account_id: input.account_id };
  if (input.security_id) params.security_id = input.security_id;
  if (input.price !== undefined && input.price !== null && input.price >= 0) {
    params.price = String(input.price);
  }
  if (input.iso_currency_code) params.iso_currency_code = input.iso_currency_code;

  // Rounded to numeric(15,6): subtracting two snapshot quantities in floating
  // point leaves noise like 0.6232000000000539.
  const quantity =
    input.quantity !== undefined && input.quantity !== null && Number.isFinite(input.quantity)
      ? Math.round(input.quantity * 1e6) / 1e6
      : 0;
  if (input.quantity !== undefined && input.quantity !== null && Number.isFinite(input.quantity)) {
    params.quantity = String(quantity);
  }
  if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) params.date = input.date;

  const canonical = normalizeShareMovement(
    {
      type: InvestmentTransactionType.Buy,
      quantity,
      price: input.price ?? 0,
      amount: Math.round(quantity * (input.price ?? 0) * 100) / 100,
    },
    "quantity",
  );
  params.type = canonical.type;

  return { params, canonical };
};

/**
 * Shared entry-point for the "Add Transaction" and "Add Investment
 * Transaction" mint flows on `AccountProperties` and `HoldingProperties`:
 *
 *   GET  /api/new-*transaction?... → mint shell on server (source='manual')
 *   optimistic shell inserted into data.transactions / .investmentTransactions
 *   indexedDb.save(shell)
 *   router.go(PATH.TRANSACTION_DETAIL, { params: { <id> } })
 *
 * Callers pass account-level context (`account_id`, `iso_currency_code`) and
 * holding-level context (`security_id`, `price`) when available; defaults
 * fall through to the server-side createManual* helpers.
 */
export const useTransactionEntry = () => {
  const { setData, router } = useAppContext();

  /** Cash-side mint (`Add Transaction`, gated on manual accounts). */
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
   *  filters zero-amount rows unless `source='manual'`). */
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
      const { params, canonical } = mintInvestmentTransactionRequest(input);

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
        date: input.date ?? new Date().toISOString().split("T")[0],
        name,
        // The same values the mint was asked for, so the shell cannot be a
        // differently-shaped row than the record. The amount also keeps it
        // out of the transaction list's zero-amount filter.
        ...canonical,
        iso_currency_code: input.iso_currency_code ?? null,
        subtype:
          canonical.type === InvestmentTransactionType.Sell
            ? InvestmentTransactionSubtype.Sell
            : InvestmentTransactionSubtype.Buy,
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
