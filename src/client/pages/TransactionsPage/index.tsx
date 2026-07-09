import { AccountType } from "plaid";
import { useMemo, useState } from "react";
import { DeepPartial, isSubset, LocalDate } from "common";
import {
  call,
  Data,
  Transaction,
  SplitTransaction,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  SplitTransactionDictionary,
  TransactionDictionary,
  TransferDictionary,
  indexedDb,
  useAppContext,
  PATH,
  useSorter,
} from "client";
import {
  InvestmentTransactionHeaders,
  TransactionHeaders,
  TransactionsPageTitle,
  TransactionsTable,
  parseTransactionsTypes,
} from "client/components";
import { useTransactionHit } from "./hooks";
import { isInConfirmedTransfer, isSuggestedLabel, TypePredicates } from "./filter";
import "./index.css";

export type TransactionsPageParams = {
  /** Comma-separated list of `TransactionsPageType` values (e.g.
   *  `expenses,transfers`). Single values stay valid for callers
   *  that link in with one filter pre-selected (BudgetDetailPage
   *  uses `transactions_type=unsorted`). */
  transactions_type?: string;
  budget_id?: string;
  account_id?: string;
  category_id?: string;
};

export const TransactionsPage = () => {
  const { data, calculations, viewDate, router, setData } = useAppContext();
  const {
    transactions,
    investmentTransactions,
    splitTransactions,
    accounts,
    institutions,
    budgets,
    sections,
    categories,
    transfers,
  } = data;
  const { transactionFamilies } = calculations;

  const [searchValue, setSearchValue] = useState("");

  const params = router.getActiveParams(PATH.TRANSACTIONS);
  const typesRaw = params.get("transactions_type");
  const types = useMemo(() => parseTransactionsTypes(typesRaw), [typesRaw]);
  const account_id = params.get("account_id") || "";
  const budget_id = params.get("budget_id") || "";
  const section_id = params.get("section_id") || "";
  const category_id = params.get("category_id") || "";

  const account = accounts.get(account_id);
  const budget = budgets.get(budget_id);
  const section = sections.get(section_id);
  const category = categories.get(category_id);

  const isInvestment = account?.type === AccountType.Investment;

  const hit = useTransactionHit();

  // Stable storage key for the sort preferences — distinct per
  // type-filter combination so e.g. an "expenses" sort doesn't collide
  // with an "expenses,transfers" sort.
  const sortKey = ["transactions", ...types].join("_");

  const sorter = useSorter<
    Transaction | InvestmentTransaction | SplitTransaction,
    TransactionHeaders & InvestmentTransactionHeaders
  >(sortKey, new Map([["date", "descending"]]));

  const { sort } = sorter;

  const filteredAndSorted = useMemo(() => {
    // budget_id is checked inline (with the "account default" fallback)
    // rather than via `isSubset`, because the row's own `label.budget_id`
    // may be null and the user routes the whole account to a budget. The
    // remaining identity filters go through `isSubset`.
    const filters: DeepPartial<Transaction & InvestmentTransaction> = {};
    const category_ids: string[] = [];
    if (account_id) filters.account_id = account_id;
    if (section_id) {
      section?.getChildren().forEach((c) => category_ids.push(c.id));
    }
    if (category_id) {
      if (!filters.label) filters.label = {};
      filters.label.category_id = category_id;
    }

    const filterCtx = { transfers };
    const predicates = new TypePredicates(filterCtx);

    const effectiveBudgetId = (e: Transaction | SplitTransaction | InvestmentTransaction) =>
      e.label.budget_id || accounts.get(e.account_id)?.label.budget_id || null;

    const matchesType = predicates.any(types);

    if (isInvestment) {
      const filtered = investmentTransactions.filter((e) => {
        // Zero-amount rows are hidden by default — they're the Plaid-side
        // non-trade / fee-waiver / qty=0 corrections that shouldn't
        // surface in the tx list. But manual mints from `Add
        // Transaction` / `Add Investment Transaction` / the divergence
        // "Add for N missing units" button all land with `amount=0`
        // until the user edits the value on the detail page; if they
        // abandon the mint (or it lands with just qty/price, per the
        // divergence flow before the server-side amount derivation) the
        // row exists in DB but has no surface to reach — the delete
        // affordance lives on the detail page, and the user has no
        // route back to it without the id. Keep `source='manual'` rows
        // visible so the user always has a surface to find or delete
        // their own work.
        if (!e.amount && e.source !== "manual") return false;
        const hidden = accounts.get(e.account_id)?.hide;
        if (hidden) return false;
        const transactionDate = new LocalDate(e.date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        if (!matchesType(e)) return false;
        if (budget_id && effectiveBudgetId(e) !== budget_id) return false;
        return isSubset(e, filters);
      });

      return filtered.sort((a, b) => {
        const scoreA = hit(searchValue, a);
        const scoreB = hit(searchValue, b);
        if (scoreA < scoreB) return 1;
        if (scoreA > scoreB) return -1;
        if (a.id < b.id) return 1;
        if (a.id > b.id) return -1;
        return 0;
      });
    } else {
      const filterTransaction = (e: Transaction | SplitTransaction) => {
        // Zero-amount rows are hidden by default — Plaid-side non-trade /
        // fee-waiver / qty=0 corrections. Manual mints land with amount=0
        // and need a surface to reach for editing or deletion (rationale
        // duplicated from the invest branch above). SplitTransaction has
        // no `source` field of its own — splits inherit from their parent,
        // and splits of manual parents can't be mint-abandoned via a
        // dedicated shell, so the manual escape doesn't apply here.
        const isManualParent = e instanceof Transaction && e.source === "manual";
        if (!e.amount && !isManualParent) return false;
        const hidden = accounts.get(e.account_id)?.hide;
        if (hidden) return false;
        const date = "authorized_date" in e ? e.authorized_date || e.date : e.date;
        const transactionDate = new LocalDate(date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        if (!matchesType(e)) return false;

        // A confirmed transfer carries no budget meaning (getBudgetData
        // excludes it — and its splits — from totals), so it must not
        // surface under a budget / section / category drill-down. Keyed on
        // transaction_id so a split of a confirmed transfer is excluded too,
        // matching getBudgetData. The default and account/transfers views
        // still show it; only the budget-semantic filters drop it. Suggested
        // transfers still count toward budget, so they stay.
        if ((budget_id || section_id || category_id) && isInConfirmedTransfer(e, filterCtx)) {
          return false;
        }

        // Effective budget_id falls back to the account's default so a row
        // routed via account default still shows under the budget filter
        // (the previous short-circuit returned true here, bypassing every
        // downstream filter including the orphan-split guard — a small bug
        // closed by inlining the check instead).
        if (budget_id && effectiveBudgetId(e) !== budget_id) return false;

        // filters out orphaned split transactions
        if (!transactions.has(e.transaction_id)) return false;

        if (!isSubset(e, filters)) return false;

        if (section_id && !category_id) return category_ids.includes(e.label.category_id!);

        return true;
      };

      const filtered = [
        ...transactions.filter(filterTransaction),
        ...splitTransactions.filter(filterTransaction),
      ].sort((a, b) =>
        a.transaction_id > b.transaction_id ? 1 : a.transaction_id === b.transaction_id ? 0 : -1,
      );

      const sortedByColumns = sort(filtered, (e, key) => {
        if (e instanceof InvestmentTransaction) {
          if (key === "date") {
            return new LocalDate(e.date);
          } else if (key === "account") {
            const account = accounts.get(e.account_id);
            return account?.custom_name || account?.name || "";
          } else if (key === "institution") {
            const account = accounts.get(e.account_id);
            return institutions.get(account?.institution_id || "")?.name || "";
          } else {
            return e[key as keyof InvestmentTransaction] || e.id;
          }
        } else {
          const t = e.toTransaction();
          if (key === "date") {
            return new LocalDate(t.authorized_date || t.date);
          } else if (key === "merchant_name") {
            return t.merchant_name || t.name || "";
          } else if (key === "account") {
            const account = accounts.get(t.account_id);
            return account?.custom_name || account?.name || "";
          } else if (key === "institution") {
            const account = accounts.get(t.account_id);
            return institutions.get(account?.institution_id || "")?.name || "";
          } else if (key === "category") {
            return categories.get(e.label.category_id || "")?.name || "";
          } else if (key === "budget") {
            const account = accounts.get(t.account_id);
            const budget_id = e.label.budget_id || account?.label.budget_id;
            return budgets.get(budget_id || "")?.name || "";
          } else if (key === "location") {
            const { city, region, country } = t.location;
            return [city, region || country].filter((e) => e).join(", ");
          } else if (key === "amount") {
            return t.getRemainingAmount(transactionFamilies);
          } else {
            return t[key as keyof Transaction] || t.id;
          }
        }
      });

      if (!searchValue) return sortedByColumns;

      return sortedByColumns.sort((a, b) => {
        const hitA = hit(searchValue, a);
        const hitB = hit(searchValue, b);
        if (hitA < hitB) return 1;
        if (hitA > hitB) return -1;
        return 0;
      });
    }
  }, [
    isInvestment,
    transactions,
    investmentTransactions,
    splitTransactions,
    accounts,
    viewDate,
    types,
    transfers,
    budgets,
    categories,
    institutions,
    sort,
    account_id,
    budget_id,
    section_id,
    category_id,
    hit,
    searchValue,
    section,
    transactionFamilies,
  ]);

  const suggestedInView = filteredAndSorted.filter(isSuggestedLabel);
  // Suggested transfer pairs whose halves intersect the current view. A pair
  // is uniquely keyed by `pair_id`, and one row in `filteredAndSorted` can
  // anchor it via either `transaction_id_a` or `_b` — so dedupe by pair_id.
  const suggestedTransferPairsInView = useMemo(() => {
    const visibleIds = new Set(filteredAndSorted.map((e) => e.id));
    const pairs: { pair_id: string }[] = [];
    data.transfers.forEach((pair) => {
      if (pair.status !== "suggested") return;
      // The pair is keyed uniquely by pair_id (dictionary iteration is already
      // deduped). A pair is "in view" if either half's transaction id is
      // visible.
      if (pair.transactions.some((t) => visibleIds.has(t.transaction_id))) {
        pairs.push({ pair_id: pair.pair_id });
      }
    });
    return pairs;
  }, [filteredAndSorted, data.transfers]);
  const totalSuggestedCount = suggestedInView.length + suggestedTransferPairsInView.length;
  const [isAccepting, setIsAccepting] = useState(false);

  // Accept-All: bulk-confirm every suggested label AND every suggested
  // transfer pair in the current filtered/sorted view. Scoped to whatever's
  // visible (router-state aware because `filteredAndSorted` is derived from
  // `path` / `params`). Per issue #98 §3: "Scoped to current transaction
  // list view".
  const onClickAcceptAll = async () => {
    if (!totalSuggestedCount || isAccepting) return;
    setIsAccepting(true);
    const labelResults = await Promise.allSettled(
      suggestedInView.map((e) => {
        if (e instanceof InvestmentTransaction) {
          return call.post("/api/investment-transaction", {
            investment_transaction_id: e.id,
            label: { category_confidence: 1 },
          });
        } else if (e instanceof SplitTransaction) {
          return call.post("/api/split-transaction", {
            split_transaction_id: e.id,
            label: { category_confidence: 1 },
          });
        } else {
          return call.post("/api/transaction", {
            transaction_id: e.id,
            label: { category_confidence: 1 },
          });
        }
      }),
    );
    const transferResults = await Promise.allSettled(
      suggestedTransferPairsInView.map((p) =>
        call.post("/api/transfers/pair", { pair_id: p.pair_id }),
      ),
    );

    const acceptedIds = new Set<string>();
    let failedLabels = 0;
    let firstFailedLabelMessage: string | undefined;
    labelResults.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.status === "success") {
        acceptedIds.add(suggestedInView[i]!.id);
      } else {
        failedLabels++;
        if (!firstFailedLabelMessage && r.status === "fulfilled" && r.value.message) {
          firstFailedLabelMessage = r.value.message;
        }
      }
    });
    const acceptedPairIds = new Set<string>();
    let failedPairs = 0;
    let firstFailedPairMessage: string | undefined;
    transferResults.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.status === "success") {
        acceptedPairIds.add(suggestedTransferPairsInView[i]!.pair_id);
      } else {
        failedPairs++;
        if (!firstFailedPairMessage && r.status === "fulfilled" && r.value.message) {
          firstFailedPairMessage = r.value.message;
        }
      }
    });

    // Surface any per-item failures so the user knows the bulk Accept-All
    // wasn't fully applied. Common cause: a transfer pair-confirm collides
    // with an already-confirmed pair (per the #547 integrity guard). Per-row
    // mutations surface via `useTransfers.confirm`'s alert; the bulk path
    // had no such signal before — failures were silently dropped from
    // `acceptedPairIds`.
    const totalFailed = failedLabels + failedPairs;
    if (totalFailed > 0) {
      const totalAttempted = labelResults.length + transferResults.length;
      const sampleMessage = firstFailedPairMessage ?? firstFailedLabelMessage;
      const detail = sampleMessage ? ` First reason: ${sampleMessage}` : "";
      window.alert(
        `${totalFailed} of ${totalAttempted} couldn't be accepted` +
          ` (likely a collision with an existing confirmed pair or stale state).${detail}`,
      );
    }

    if (acceptedIds.size || acceptedPairIds.size) {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newTransactions = new TransactionDictionary(newData.transactions);
        const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
        const newInvest = new InvestmentTransactionDictionary(newData.investmentTransactions);
        acceptedIds.forEach((id) => {
          const existing = newTransactions.get(id) || newSplits.get(id) || newInvest.get(id);
          if (!existing) return;
          if (existing instanceof InvestmentTransaction) {
            const updated = new InvestmentTransaction(existing);
            updated.label.category_confidence = 1;
            indexedDb.save(updated).catch(console.error);
            newInvest.set(id, updated);
          } else if (existing instanceof SplitTransaction) {
            const updated = new SplitTransaction(existing);
            updated.label.category_confidence = 1;
            indexedDb.save(updated).catch(console.error);
            newSplits.set(id, updated);
          } else {
            const updated = new Transaction(existing);
            updated.label.category_confidence = 1;
            indexedDb.save(updated).catch(console.error);
            newTransactions.set(id, updated);
          }
        });
        newData.transactions = newTransactions;
        newData.splitTransactions = newSplits;
        newData.investmentTransactions = newInvest;

        if (acceptedPairIds.size) {
          const newTransfers = new TransferDictionary(newData.transfers);
          acceptedPairIds.forEach((pair_id) => {
            const prev = newTransfers.get(pair_id);
            if (!prev) return;
            const updated = { ...prev, status: "confirmed" as const };
            indexedDb.saveTransfer(updated).catch(console.error);
            newTransfers.set(pair_id, updated);
          });
          newData.transfers = newTransfers;
        }

        return newData;
      });
    }

    setIsAccepting(false);
  };

  return (
    <div className="TransactionsPage">
      <TransactionsPageTitle
        filters={{ account, budget, section, category }}
        sorter={sorter}
        onChangeSearchValue={setSearchValue}
      />
      {!!totalSuggestedCount && (
        <div className="acceptAllSuggestions">
          <button
            className="acceptAllSuggestionsButton"
            onClick={onClickAcceptAll}
            disabled={isAccepting}
          >
            {isAccepting
              ? `Accepting ${totalSuggestedCount}…`
              : `Accept all ${totalSuggestedCount} suggestion${
                  totalSuggestedCount === 1 ? "" : "s"
                }`}
          </button>
        </div>
      )}
      <TransactionsTable transactions={filteredAndSorted} />
    </div>
  );
};
