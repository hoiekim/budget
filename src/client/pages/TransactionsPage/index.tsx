import { AccountType } from "plaid";
import { useMemo, useState } from "react";
import { useAppContext, PATH, useSorter } from "client";
import {
  InvestmentTransactionHeaders,
  TransactionHeaders,
  TransactionsPageTitle,
  TransactionsPageType,
  TransactionsTable,
} from "client/components";
import {
  Transaction,
  DeepPartial,
  isSubset,
  SplitTransaction,
  InvestmentTransaction,
} from "common";
import { useTransactionHit } from "./hooks";

export type TransactionsPageParams = {
  type?: TransactionsPageType;
  budget_id?: string;
  account_id?: string;
  category_id?: string;
};

export const TransactionsPage = () => {
  const { data, viewDate, router } = useAppContext();
  const {
    transactions,
    investmentTransactions,
    splitTransactions,
    accounts,
    institutions,
    budgets,
    categories,
  } = data;
  const { path, params, transition } = router;
  const { incomingParams } = transition;

  const [searchValue, setSearchValue] = useState("");

  let type: TransactionsPageType | undefined;
  let account_id: string;
  let budget_id: string;
  let category_id: string;
  if (path === PATH.TRANSACTIONS) {
    type = (params.get("type") as TransactionsPageType) || undefined;
    account_id = params.get("account_id") || "";
    budget_id = params.get("budget_id") || "";
    category_id = params.get("category_id") || "";
  } else {
    type = (incomingParams.get("type") as TransactionsPageType) || undefined;
    account_id = incomingParams.get("account_id") || "";
    budget_id = incomingParams.get("budget_id") || "";
    category_id = incomingParams.get("category_id") || "";
  }

  const account = accounts.get(account_id);
  const budget = budgets.get(budget_id);
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
    if (account_id) filters.account_id = account_id;
    if (budget_id) {
      if (!filters.label) filters.label = {};
      filters.label.budget_id = budget_id;
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
        const transactionDate = new Date(e.date);
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
        const transactionDate = new Date(date);
        const within = viewDate.has(transactionDate);
        if (!within) return false;
        if (type === "unsorted" && e.label.category_id) return false;
        if (type === "deposits" && e.amount > 0) return false;
        if (type === "expenses" && e.amount < 0) return false;

        if (!isInvestment && !e.label.budget_id) {
          const account = accounts.get(e.account_id);
          if (account?.label.budget_id === budget_id) return true;
        }

        // filters out orphaned split transactions
        if (!transactions.has(e.transaction_id)) return false;

        return isSubset(e, filters);
      };

      const filtered = [
        ...transactions.filter(filterTransaction),
        ...splitTransactions.filter(filterTransaction),
      ];

      return sort(filtered, (e, key) => {
        if (e instanceof InvestmentTransaction) {
          if (key === "date") {
            return new Date(e.date);
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
          const { hypotheticalTransaction: t } = e;
          if (key === "authorized_date") {
            return new Date(t.authorized_date || t.date);
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
          } else {
            return t[key as keyof Transaction] || t.id;
          }
        }
      }).sort((a, b) => {
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
    category_id,
    hit,
    searchValue,
  ]);

  return (
    <div className="TransactionsPage">
      <TransactionsPageTitle
        filters={{ type, account, budget, category }}
        sorter={sorter}
        onChangeSearchValue={setSearchValue}
      />
      <TransactionsTable transactions={filteredAndSorted} />
    </div>
  );
};
