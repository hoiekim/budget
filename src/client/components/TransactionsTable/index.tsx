import { useCallback, useMemo } from "react";
import { SplitTransaction, Transaction } from "common";
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
  transactionsArray: (Transaction | SplitTransaction)[];
  customKey?: string;
  top?: number;
}

const TransactionsTable = ({ transactionsArray, customKey, top }: Props) => {
  const { data } = useAppContext();
  const { accounts, institutions, budgets, categories } = data;

  const sorter = useSorter<Transaction | SplitTransaction, TransactionHeaders>(
    "transactions" + (customKey ? `_${customKey}` : ""),
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
        return t[key];
      }
    });
  }, [transactionsArray, accounts, institutions, categories, budgets, sort]);

  const transactionRows = sortedTransactionsArray.map((e) => {
    return <TransactionRow key={e.id} transaction={e} />;
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
    } else if (key === "location") {
      return "Location";
    } else {
      return key;
    }
  }, []);

  return (
    <div className="TransactionsTable">
      <div>
        <TransactionsHead sorter={sorter} getHeader={getHeader} style={{ top }} />
        <div>{transactionRows}</div>
      </div>
    </div>
  );
};

export default TransactionsTable;
