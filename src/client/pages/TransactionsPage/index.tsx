import { useMemo } from "react";
import { useAppContext, PATH } from "client";
import { TransactionsTable } from "client/components";
import { Transaction, DeepPartial, isSubset } from "common";
import "./index.css";

export type TransactionsPageParams = {
  option?: "unsorted" | "income";
  budget_id?: string;
  account_id?: string;
  category_id?: string;
};

const TransactionsPage = () => {
  const { data, viewDate, router } = useAppContext();
  const { transactions, accounts, categories } = data;
  const { path, params, transition } = router;
  const { incomingParams } = transition;

  let option: string;
  let account_id: string;
  let budget_id: string;
  let category_id: string;
  if (path === PATH.TRANSACTIONS) {
    option = params.get("option") || "all";
    account_id = params.get("account_id") || "";
    budget_id = params.get("budget_id") || "";
    category_id = params.get("category_id") || "";
  } else {
    option = incomingParams.get("option") || "all";
    account_id = incomingParams.get("account_id") || "";
    budget_id = incomingParams.get("budget_id") || "";
    category_id = incomingParams.get("category_id") || "";
  }

  const transactionsArray = useMemo(() => {
    const result: Transaction[] = [];
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = viewDate.has(transactionDate);
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
    return transactionsArray.filter((e) => {
      if (!e.label.budget_id) {
        const account = accounts.get(e.account_id);
        if (account?.label.budget_id === budget_id) return true;
      }
      return isSubset(e, filters);
    });
  }, [transactionsArray, accounts, account_id, budget_id, category_id]);

  const filteringAccount = accounts.get(account_id);
  const filteringCategory = categories.get(category_id);
  const title =
    filteringAccount?.custom_name || filteringAccount?.name || filteringCategory?.name;
  const Title = () => {
    if (title) {
      return (
        <>
          <h2>{title}</h2>
          <h3>Transactions</h3>
        </>
      );
    }
    return <h2>{option[0].toUpperCase() + option.slice(1) + " Transactions"}</h2>;
  };

  return (
    <div className="TransactionsPage">
      <Title />
      <TransactionsTable
        customKey={option}
        transactionsArray={filteredTransactions}
        top={title ? 138 : 95}
      />
    </div>
  );
};

export default TransactionsPage;
