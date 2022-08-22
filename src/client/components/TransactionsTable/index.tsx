import { useCallback, useMemo, MutableRefObject } from "react";
import { Transaction } from "server";
import { useAppContext, useSorter } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";
import "./index.css";

export type TransactionHeaders = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
  budget?: boolean;
};

interface Props {
  transactionsArray: Transaction[];
}

const TransactionsTable = ({ transactionsArray }: Props) => {
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

  const { sort, visibles, toggleVisible } = sorter;

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
    return <TransactionRow key={e.transaction_id} transaction={e} sorter={sorter} />;
  });

  const getHeader = useCallback((key: keyof TransactionHeaders): string => {
    if (key === "authorized_date") {
      return "Date";
    } else if (key === "merchant_name") {
      return "Name";
    } else if (key === "amount") {
      return "Amount";
    } else if (key === "account") {
      return "Account";
    } else if (key === "institution") {
      return "Institution";
    } else if (key === "budget") {
      return "Budget";
    } else if (key === "category") {
      return "Category";
    } else {
      return key;
    }
  }, []);

  const hiddenColumns = useMemo(() => {
    return Object.entries(visibles)
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
  }, [getHeader, toggleVisible, visibles]);

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
