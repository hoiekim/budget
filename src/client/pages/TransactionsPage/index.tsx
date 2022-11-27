import { useMemo } from "react";
import { useAppContext } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";
import "./index.css";

export interface TransactionsPageParams {
  option?: "unsorted" | "income";
  account_id?: string;
}

const TransactionsPage = () => {
  const { transactions, accounts, viewDate, router } = useAppContext();
  const { params } = router;

  const option = params.get("option") || "all";

  const transactionsArray = useMemo(() => {
    const result: Transaction[] = [];
    const viewDateClone = viewDate.clone();
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = viewDateClone.has(transactionDate);
      if (hidden || !within) return;

      if (option === "unsorted") {
        if (!e.label.category_id) result.push(e);
      } else if (option === "income") {
        if (e.amount < 0) result.push(e);
      } else {
        result.push(e);
      }
    });
    return result;
  }, [transactions, accounts, viewDate, option]);

  const filteredTransactions = useMemo(() => {
    const filters: Partial<Transaction> = {
      account_id: params.get("account_id") || undefined,
    };
    return transactionsArray.filter((e) => {
      let pass = true;
      Object.entries(filters).forEach(([key, value]) => {
        if (value && value !== e[key as keyof Transaction]) pass = false;
      });
      return pass;
    });
  }, [transactionsArray, params]);

  return (
    <div className="TransactionsPage">
      <h2>{option[0].toUpperCase() + option.slice(1)} Transactions</h2>
      <TransactionsTable customKey={option} transactionsArray={filteredTransactions} />
    </div>
  );
};

export default TransactionsPage;
