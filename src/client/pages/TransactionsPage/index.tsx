import { AccountType } from "plaid";
import { useMemo, useState } from "react";
import { useAppContext, PATH } from "client";
import { InvestmentTransactionsTable, TransactionsTable } from "client/components";
import {
  Transaction,
  DeepPartial,
  isSubset,
  SplitTransaction,
  toTitleCase,
  Budget,
  Category,
  Account,
  InvestmentTransaction,
} from "common";
import "./index.css";

type TransactionsPageType = "deposits" | "expenses" | "unsorted";

interface TransactionsPageFilters {
  type?: TransactionsPageType;
  account?: Account;
  budget?: Budget;
  category?: Category;
}

interface TransactionsPageTitleProps {
  filters: TransactionsPageFilters;
}

enum TITLES {
  all = "All Transactions",
  unsorted = "Unsorted Transactions",
  deposits = "Deposits",
  expenses = "Expenses",
}

const typeToTitle = (type?: TransactionsPageType) => {
  if (type) return TITLES[type];
  return "All Transactions";
};

const TransactionsPageTitle = ({ filters }: TransactionsPageTitleProps) => {
  const { type: selectedType, account, budget, category } = filters;
  const { router } = useAppContext();
  const { go, path, params } = router;

  const [isSelecting, setIsSelecting] = useState(false);

  const options = [...Object.entries(TITLES)].map(([type, title]) => {
    const isSelected = type === (selectedType || "all");
    const onClickSelectOption = () => {
      setIsSelecting(false);
      const newParams = new URLSearchParams(params);
      if (type === "all") newParams.delete("type");
      else newParams.set("type", type as TransactionsPageType);
      go(path, { params: newParams, animate: false });
    };
    return (
      <button key={title} onClick={onClickSelectOption}>
        {isSelected && <span className="checkmark">✓</span>}
        <span>{title}</span>
      </button>
    );
  });

  const accountName = account?.name || account?.custom_name;
  const budgetName = budget?.name;
  const categoryName = category?.name;
  const subtitle = [accountName, categoryName, budgetName].find(Boolean);

  const onClickSelect = () => setIsSelecting((v) => !v);
  const closeSelect = () => setIsSelecting(false);

  return (
    <>
      <h2 className="heading">
        <button onClick={onClickSelect}>
          <span>{typeToTitle(selectedType)}</span>
          <span className="chevron-down rotate90deg">〉</span>
        </button>
        {isSelecting && (
          <div className="select" onMouseLeave={closeSelect}>
            <div className="selectLabel" onClick={closeSelect}>
              <span>Select&nbsp;transaction&nbsp;type</span>
              <button className="closeButton">✕</button>
            </div>
            <div className="options">{options}</div>
          </div>
        )}
      </h2>
      {!!subtitle && (
        <h3 className="heading">
          <span>{toTitleCase(subtitle)}</span>
        </h3>
      )}
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
  const { transactions, investmentTransactions, splitTransactions, accounts, budgets, categories } =
    data;
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

  const account = accounts.get(account_id);
  const budget = budgets.get(budget_id);
  const category = categories.get(category_id);

  const isInvestment = account?.type === AccountType.Investment;

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

    if (isInvestment) {
      return investmentTransactions.filter((e) => {
        const hidden = accounts.get(e.account_id)?.hide;
        const transactionDate = new Date(e.date);
        const within = viewDate.has(transactionDate);
        if (hidden || !within) return false;
        if (type === "deposits" && e.amount > 0) return false;
        return isSubset(e, filters);
      });
    } else {
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

        if (!isInvestment && !e.label.budget_id) {
          const account = accounts.get(e.account_id);
          if (account?.label.budget_id === budget_id) return true;
        }
        return isSubset(e, filters);
      });
    }
  }, [
    isInvestment,
    transactions,
    investmentTransactions,
    accounts,
    viewDate,
    type,
    account_id,
    budget_id,
    category_id,
  ]);

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

  const transactionsToDisplay: (Transaction | InvestmentTransaction | SplitTransaction)[] =
    useMemo(() => {
      return [...filteredTransactions, ...filteredSplitTransactionsArray].sort((a, b) => {
        if (a.id === b.id) return 0;
        if (a.id < b.id) return 1;
        return -1;
      });
    }, [filteredTransactions, filteredSplitTransactionsArray]);

  return (
    <div className="TransactionsPage">
      <TransactionsPageTitle filters={{ type, account, budget, category }} />
      {isInvestment ? (
        <InvestmentTransactionsTable
          sorterKey={type}
          transactionsArray={transactionsToDisplay as InvestmentTransaction[]}
          top={account || budget || category ? 139 : 95}
        />
      ) : (
        <TransactionsTable
          sorterKey={type}
          transactionsArray={transactionsToDisplay as (Transaction | SplitTransaction)[]}
          top={account || budget || category ? 139 : 95}
        />
      )}
    </div>
  );
};

export default TransactionsPage;
