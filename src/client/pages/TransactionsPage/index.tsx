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
  TransactionsPageType,
  TransactionsTable,
} from "client/components";
import { useTransactionHit } from "./hooks";
import "./index.css";

// A transaction (or split / investment-transaction) has an unreviewed
// suggestion when its label has a category set and the confidence is in
// the open interval (0, 1). 0=rejected, 1=confirmed, null=never labeled
// — per the JSONTransactionLabel docstring.
const isSuggestedLabel = (e: Transaction | SplitTransaction | InvestmentTransaction): boolean => {
  const c = e.label.category_confidence;
  return !!e.label.category_id && c !== null && c !== undefined && c > 0 && c < 1;
};

export type TransactionsPageParams = {
  transactions_type?: TransactionsPageType;
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
  } = data;
  const { transactionFamilies } = calculations;
  const { path, params, transition } = router;
  const { incomingParams } = transition;

  const [searchValue, setSearchValue] = useState("");

  let type: TransactionsPageType | undefined;
  let account_id: string;
  let budget_id: string;
  let section_id: string;
  let category_id: string;
  if (path === PATH.TRANSACTIONS || screenType !== ScreenType.Narrow) {
    type = (params.get("transactions_type") as TransactionsPageType) || undefined;
    account_id = params.get("account_id") || "";
    budget_id = params.get("budget_id") || "";
    section_id = params.get("section_id") || "";
    category_id = params.get("category_id") || "";
  } else {
    type = (incomingParams.get("transactions_type") as TransactionsPageType) || undefined;
    account_id = incomingParams.get("account_id") || "";
    budget_id = incomingParams.get("budget_id") || "";
    section_id = incomingParams.get("section_id") || "";
    category_id = incomingParams.get("category_id") || "";
  }

  const account = accounts.get(account_id);
  const budget = budgets.get(budget_id);
  const section = sections.get(section_id);
  const category = categories.get(category_id);

  const isInvestment = account?.type === AccountType.Investment;

  const hit = useTransactionHit();

  const sortKey = ["transactions", type].filter(Boolean).join("_");

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

    if (isInvestment) {
      const filtered = investmentTransactions.filter((e) => {
        if (!e.amount) return false;
        const hidden = accounts.get(e.account_id)?.hide;
        if (hidden) return false;
        const transactionDate = new LocalDate(e.date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        if (type === "deposits" && e.amount > 0) return false;
        if (type === "expenses" && e.amount < 0) return false;
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
        // "unsorted" view now includes every transaction that is not
         // user-confirmed (confidence === 1). That covers genuinely
         // unlabeled rows AND auto-suggested ones — per Hoie's directive
         // in #98: suggested + non-confirmed both belong here.
         if (type === "unsorted" && e.label.category_confidence === 1) return false;
         // "suggested" view is the narrower slice: rows currently bearing
         // an unreviewed auto-suggestion (0 < confidence < 1).
         if (type === "suggested") {
           const c = e.label.category_confidence;
           if (c === null || c === undefined || c <= 0 || c >= 1) return false;
         }
        if (type === "deposits" && e.amount > 0) return false;
        if (type === "expenses" && e.amount < 0) return false;

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
    type,
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
  const [isAccepting, setIsAccepting] = useState(false);

  // Accept-All: bulk-confirm every suggested label in the current
  // filtered/sorted view. Scoped to whatever's visible (router-state aware
  // because `filteredAndSorted` is derived from `path` / `params`). Per
  // issue #98 §3: "Scoped to current transaction list view".
  const onClickAcceptAll = async () => {
    if (!suggestedInView.length || isAccepting) return;
    setIsAccepting(true);
    const results = await Promise.allSettled(
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

    const acceptedIds = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.status === "success") {
        acceptedIds.add(suggestedInView[i]!.id);
      }
    });

    if (acceptedIds.size) {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newTransactions = new TransactionDictionary(newData.transactions);
        const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
        const newInvest = new InvestmentTransactionDictionary(newData.investmentTransactions);
        acceptedIds.forEach((id) => {
          const existing =
            newTransactions.get(id) || newSplits.get(id) || newInvest.get(id);
          if (!existing) return;
          if (existing instanceof InvestmentTransaction) {
            const updated = new InvestmentTransaction(existing);
            updated.label.category_confidence = 1;
            indexedDb.save(updated).catch(console.error);
            newInvest.set(id, updated);
          } else if (existing instanceof SplitTransaction) {
            const parent = newData.transactions.get(existing.transaction_id);
            if (!parent) return;
            const updated = new SplitTransaction(parent);
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
        return newData;
      });
    }

    setIsAccepting(false);
  };

  return (
    <div className="TransactionsPage">
      <TransactionsPageTitle
        filters={{ type, account, budget, section, category }}
        sorter={sorter}
        onChangeSearchValue={setSearchValue}
      />
      {!!suggestedInView.length && (
        <div className="acceptAllSuggestions">
          <button
            className="acceptAllSuggestionsButton"
            onClick={onClickAcceptAll}
            disabled={isAccepting}
          >
            {isAccepting
              ? `Accepting ${suggestedInView.length}…`
              : `Accept all ${suggestedInView.length} suggestion${
                  suggestedInView.length === 1 ? "" : "s"
                }`}
          </button>
        </div>
      )}
      <TransactionsTable transactions={filteredAndSorted} />
    </div>
  );
};
