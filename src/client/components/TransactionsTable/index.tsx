import { useMemo } from "react";
import { Transaction } from "server";
import { useAppContext, useSorter, IsNow } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";
import "./index.css";

export type TransactionHeaders = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

const TransactionsTable = () => {
  const { transactions, accounts, institutions, budgets, selectedBudgetId } =
    useAppContext();

  const sorter = useSorter<Transaction, TransactionHeaders>(
    "transactions",
    new Map([["authorized_date", "descending"]]),
    {
      authorized_date: true,
      merchant_name: true,
      amount: true,
      account: true,
      institution: true,
      category: true,
    }
  );

  const { sort, visibles, toggleVisible } = sorter;

  const isNow = useMemo(() => new IsNow(), []);
  const budget = useMemo(
    () => budgets.get(selectedBudgetId),
    [budgets, selectedBudgetId]
  );

  const filteredTransactionsArray = useMemo(
    () =>
      Array.from(transactions.values()).filter((e) => {
        if (!budget) return false;

        const account = accounts.get(e.account_id);
        if (account) {
          const { labels } = account;
          const label = labels.find((f) => f.budget_id === selectedBudgetId);
          if (label?.hide) return false;

          const transactionDate = new Date(e.authorized_date || e.date);
          return isNow.within(budget.interval).from(transactionDate);
        }

        return false;
      }),
    [accounts, budget, isNow, selectedBudgetId, transactions]
  );

  const sortedTransactionsArray = useMemo(
    () =>
      sort(filteredTransactionsArray, (e, key) => {
        if (key === "authorized_date") {
          return new Date(e.authorized_date || e.date);
        } else if (key === "merchant_name") {
          return e.merchant_name || e.name;
        } else if (key === "account") {
          return accounts.get(e.account_id)?.name;
        } else if (key === "institution") {
          const account = accounts.get(e.account_id);
          return institutions.get(account?.institution_id || "")?.name;
        } else if (key === "category") {
          return e.category && e.category[0];
        } else {
          return e[key];
        }
      }),
    [accounts, institutions, sort, filteredTransactionsArray]
  );

  const transactionRows = sortedTransactionsArray.map((e) => {
    return <TransactionRow key={e.transaction_id} transaction={e} sorter={sorter} />;
  });

  const getHeader = (key: keyof TransactionHeaders): string => {
    if (key === "authorized_date") {
      return "Date";
    } else if (key === "merchant_name") {
      return "Name";
    } else if (key === "amount") {
      return "Amount";
    } else if (key === "account") {
      return "Account";
    } else if (key === "institution") {
      return "Institutions";
    } else if (key === "category") {
      return "Category";
    } else {
      return key;
    }
  };

  const hiddenColumns = Object.entries(visibles)
    .filter(([key, value]) => !value)
    .map(([key, value], i) => {
      return (
        <button
          key={`transactions_hidden_column_${i}`}
          onClick={() => toggleVisible(key as keyof typeof visibles)}
        >
          {getHeader(key as keyof typeof visibles)}
        </button>
      );
    });

  return (
    <div className="TransactionsTable">
      <div>Transactions:</div>
      <div>{hiddenColumns}</div>
      <table>
        <TransactionsHead sorter={sorter} getHeader={getHeader} />
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default TransactionsTable;
