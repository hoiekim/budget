import { useMemo } from "react";
import { Transaction } from "server";
import { useAppContext, useSorter } from "client";
import TransactionItem from "./TransactionItem";
import "./index.css";

export type TransactionHeaders = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
  budget?: boolean;
};

interface Props {
  transactionsArray: Transaction[];
}

const TransactionsList = ({ transactionsArray }: Props) => {
  const { accounts, institutions, budgets, categories } = useAppContext();

  const sorter = useSorter<Transaction, TransactionHeaders>(
    "transactions",
    new Map([["authorized_date", "descending"]]),
    {
      authorized_date: true,
      merchant_name: true,
      amount: true,
      account: true,
      institution: true,
      budget: true,
      category: true,
    }
  );

  const { sort } = sorter;

  const sortedTransactionsArray = useMemo(() => {
    return sort([...transactionsArray], (e, key) => {
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
        return categories.get(e.label.category_id || "")?.name;
      } else if (key === "budget") {
        return budgets.get(e.label.budget_id || "")?.name;
      } else {
        return e[key];
      }
    });
  }, [transactionsArray, accounts, institutions, categories, budgets, sort]);

  const transactionRows = sortedTransactionsArray.map((e) => {
    return <TransactionItem key={e.transaction_id} transaction={e} />;
  });

  return <div className="TransactionsList">{transactionRows}</div>;
};

export default TransactionsList;
