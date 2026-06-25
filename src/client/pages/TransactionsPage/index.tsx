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
  ScreenType,
} from "client";
import {
  InvestmentTransactionHeaders,
  TransactionHeaders,
  TransactionsPageTitle,
  TransactionsTable,
  parseTransactionsTypes,
} from "client/components";
import { useTransactionHit } from "./hooks";
import "./index.css";

// A transaction (or split / investment-transaction) has an unreviewed
// suggestion when its label has a category set and the confidence is in
// the open interval (0, 1). 0=rejected, 1=confirmed, null=never labeled
// — per the JSONTransactionLabel docstring.
const isSuggestedLabel = (e: Transaction | SplitTransaction | InvestmentTransaction): boolean => {
  const c_id = e.label.category_id;
  const c_conf = e.label.category_confidence;
  return !!(c_id && c_conf && c_conf < 1);
};

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
  const { data, calculations, viewDate, router, screenType, setData } = useAppContext();
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
  const { path, params, transition } = router;
  const { incomingParams } = transition;

  const [searchValue, setSearchValue] = useState("");

  // Read params from the active path's URLSearchParams — same source
  // the rest of the page already reads from. Parsing the
  // `transactions_type` CSV through useMemo keyed on the raw string
  // (a primitive) so re-renders triggered by unrelated state changes
  // don't blow the `filteredAndSorted` useMemo's cache via array
  // reference instability.
  const activeParams =
    path === PATH.TRANSACTIONS || screenType !== ScreenType.Narrow ? params : incomingParams;
  const typesRaw = activeParams.get("transactions_type");
  const types = useMemo(() => parseTransactionsTypes(typesRaw), [typesRaw]);
  const account_id = activeParams.get("account_id") || "";
  const budget_id = activeParams.get("budget_id") || "";
  const section_id = activeParams.get("section_id") || "";
  const category_id = activeParams.get("category_id") || "";

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
    const filters: DeepPartial<Transaction & InvestmentTransaction> = {};
    const category_ids: string[] = [];
    if (account_id) filters.account_id = account_id;
    if (budget_id) {
      if (!filters.label) filters.label = {};
      filters.label.budget_id = budget_id;
    }
    if (section_id) {
      section?.getChildren().forEach((c) => category_ids.push(c.id));
    }
    if (category_id) {
      if (!filters.label) filters.label = {};
      filters.label.category_id = category_id;
    }

    // Multi-choice OR: an entry passes the type filter if it matches
    // ANY of the selected types (empty selection = no type filter).
    // The label/transfer types apply to regular Transactions /
    // SplitTransactions; the sign types apply to everything.
    const matchesAnySelectedType = (e: Transaction | SplitTransaction): boolean => {
      if (!types.length) return true;
      return types.some((t) => {
        if (t === "deposits") return e.amount < 0;
        if (t === "expenses") return e.amount > 0;
        if (t === "unsorted") {
          const c_id = e.label.category_id;
          const c_conf = e.label.category_confidence;
          return !(c_id && (c_conf === 1 || c_conf === 0));
        }
        if (t === "suggested") return isSuggestedLabel(e);
        if (t === "transfers") {
          // Only whole Transactions participate in transfer pairs. A
          // SplitTransaction inherits its parent's transaction_id, so an
          // unguarded lookup would resolve the PARENT's pair and leak split
          // rows into the Transfers view — same guard the render path uses
          // (TransactionsTable/index.tsx, TransactionRow.tsx).
          return (
            e instanceof Transaction &&
            transfers.byTransactionId.has(e.transaction_id)
          );
        }
        return false;
      });
    };

    // Investment transactions don't carry category labels and don't
    // participate in transfer pairs, so only the sign filters
    // (deposits / expenses) are meaningful. Other selected types are
    // no-ops on the investment branch — same as pre-PR behavior where
    // the investment branch only checked deposits/expenses and let
    // every other type fall through as a no-op.
    const matchesAnySelectedInvestmentType = (e: InvestmentTransaction): boolean => {
      if (!types.length) return true;
      const signTypes = types.filter((t) => t === "deposits" || t === "expenses");
      if (!signTypes.length) return true;
      return signTypes.some((t) => (t === "deposits" ? e.amount < 0 : e.amount > 0));
    };

    if (isInvestment) {
      const filtered = investmentTransactions.filter((e) => {
        if (!e.amount) return false;
        const hidden = accounts.get(e.account_id)?.hide;
        if (hidden) return false;
        const transactionDate = new LocalDate(e.date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        if (!matchesAnySelectedInvestmentType(e)) return false;
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
        if (!e.amount) return false;
        const hidden = accounts.get(e.account_id)?.hide;
        if (hidden) return false;
        const date = "authorized_date" in e ? e.authorized_date || e.date : e.date;
        const transactionDate = new LocalDate(date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        // Multi-choice OR across selected types. "unsorted" widens to
        // "not user-confirmed" (covers genuinely unlabeled rows AND
        // auto-suggested ones — both stay visible until the user
        // explicitly confirms a label). "suggested" is the narrower
        // slice (0 < confidence < 1). "transfers" matches any pair
        // (suggested or confirmed) — the user wants to see transfer
        // rows in either state.
        if (!matchesAnySelectedType(e)) return false;

        if (!isInvestment && !e.label.budget_id && !section_id && !category_id) {
          const account = accounts.get(e.account_id);
          if (account?.label.budget_id === budget_id) return true;
        }

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
        filters={{ types, account, budget, section, category }}
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
