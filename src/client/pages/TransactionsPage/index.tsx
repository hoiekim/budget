import { useMemo } from "react";
import { useAppContext, PATH } from "client";
import { TransactionsTable } from "client/components";
import {
  Transaction,
  DeepPartial,
  isSubset,
  SplitTransaction,
  toTitleCase,
  Budget,
  Category,
  Account,
} from "common";
import "./index.css";

type TransactionsPageType = "deposits" | "expenses" | "unsorted" | "investment";

interface TransactionsPageFilters {
  type?: TransactionsPageType;
  account?: Account;
  budget?: Budget;
  category?: Category;
}

interface TransactionsPageTitleProps {
  filters: TransactionsPageFilters;
}

const TransactionsPageTitle = ({ filters }: TransactionsPageTitleProps) => {
  const { type, account, budget, category } = filters;
  const titlePrefix = type || (account || budget || category ? undefined : "all");
  const title =
    type && ["deposits", "expenses"].includes(type)
      ? toTitleCase(type)
      : titlePrefix
      ? toTitleCase(`${titlePrefix} transactions`)
      : "Transactions";
  const accountName = account?.name || account?.custom_name;
  const budgetName = budget?.name;
  const categoryName = category?.name;
  const subtitle = [accountName, budgetName, categoryName].filter(Boolean).join(" / ");
  return (
    <>
      <h2>{toTitleCase(title)}</h2>
      {!!subtitle && <h3>{toTitleCase(subtitle)}</h3>}
    </>
  );
};

export type TransactionsPageParams = {
  type?: TransactionsPageType;
  budget_id?: string;
  account_id?: string;
  category_id?: string;
};

const TransactionsPage = () => {
  const { data, viewDate, router } = useAppContext();
  const { transactions, splitTransactions, accounts, budgets, categories } = data;
  const { path, params, transition } = router;
  const { incomingParams } = transition;

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

  const filteredTransactions = useMemo(() => {
    const filters: DeepPartial<Transaction> = {};
    if (account_id) filters.account_id = account_id;
    if (budget_id) {
      if (!filters.label) filters.label = {};
      filters.label.budget_id = budget_id;
    }
    if (category_id) {
      if (!filters.label) filters.label = {};
      filters.label.category_id = category_id;
    }
    return transactions.filter((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = viewDate.has(transactionDate);
      if (hidden || !within) return false;

      if (type === "unsorted") {
        if (e.label.category_id) return false;
      } else if (type === "deposits") {
        if (e.amount > 0) return false;
      }

      if (!e.label.budget_id) {
        const account = accounts.get(e.account_id);
        if (account?.label.budget_id === budget_id) return true;
      }
      return isSubset(e, filters);
    });
  }, [transactions, accounts, viewDate, type, account_id, budget_id, category_id]);

  const filteredSplitTransactionsArray = useMemo(() => {
    return splitTransactions.filter((e) => {
      const parentTransaction = transactions.get(e.transaction_id);
      if (!parentTransaction) return false;

      const parentAccount = accounts.get(parentTransaction.account_id);
      if (!parentAccount) return false;

      const hidden = parentAccount.hide;
      const transactionDate = new Date(e.date);
      const within = viewDate.has(transactionDate);
      if (hidden || !within) return false;

      if (type === "unsorted") {
        if (e.label.category_id) return false;
      } else if (type === "deposits") {
        if (e.amount > 0) return false;
      }
      if (account_id) {
        if (parentAccount.account_id !== account_id) return false;
      }
      if (budget_id) {
        if (!e.label.budget_id && parentAccount.label.budget_id !== budget_id) return false;
        if (e.label.budget_id !== budget_id) return false;
      }
      if (category_id) {
        if (e.label.category_id !== category_id) return false;
      }

      return true;
    });
  }, [
    transactions,
    splitTransactions,
    accounts,
    viewDate,
    type,
    account_id,
    budget_id,
    category_id,
  ]);

  const transactionsToDisplay: (Transaction | SplitTransaction)[] = useMemo(() => {
    return [...filteredTransactions, ...filteredSplitTransactionsArray].sort((a, b) => {
      if (a.transaction_id < b.transaction_id) return 1;
      if (a.transaction_id > b.transaction_id) return -1;
      return 0;
    });
  }, [filteredTransactions, filteredSplitTransactionsArray]);

  const account = accounts.get(account_id);
  const budget = budgets.get(budget_id);
  const category = categories.get(category_id);

  return (
    <div className="TransactionsPage">
      <TransactionsPageTitle filters={{ type, account, budget, category }} />
      <TransactionsTable
        sorterKey={type}
        transactionsArray={transactionsToDisplay}
        top={account || budget || category ? 138 : 95}
      />
    </div>
  );
};

export default TransactionsPage;
