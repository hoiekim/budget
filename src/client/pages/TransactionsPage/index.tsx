import { useMemo } from "react";
import { useAppContext, isSubset, PATH } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";
import "./index.css";

export interface TransactionsPageParams {
  option?: "unsorted" | "income";
  account_id?: string;
  category_id?: string;
}

const TransactionsPage = () => {
  const { transactions, accounts, viewDate, router } = useAppContext();
  const { path, params, transition } = router;
  const { incomingParams } = transition;

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
    const filters: Partial<Transaction> = {};
    let account_id: string;
    let category_id: string;
    if (path === PATH.TRANSACTIONS) {
      account_id = params.get("account_id") || "";
      category_id = params.get("category_id") || "";
    } else {
      account_id = incomingParams.get("account_id") || "";
      category_id = incomingParams.get("category_id") || "";
    }
    if (account_id) filters.account_id = account_id;
    if (category_id) {
      if (!filters.label) filters.label = {};
      filters.label.category_id = category_id;
    }
    return transactionsArray.filter((e) => isSubset(e, filters));
  }, [transactionsArray, path, params, incomingParams]);

  return (
    <div className="TransactionsPage">
      <h2>{option[0].toUpperCase() + option.slice(1)} Transactions</h2>
      <TransactionsTable customKey={option} transactionsArray={filteredTransactions} />
    </div>
  );
};

export default TransactionsPage;
