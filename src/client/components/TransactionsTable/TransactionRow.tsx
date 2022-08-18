import { useState, ChangeEventHandler, useMemo } from "react";
import { Category, Transaction } from "server";
import { useAppContext, call, Sorter, numberToCommaString } from "client";
import { InstitutionSpan } from "client/components";
import { TransactionHeaders } from ".";

interface Props {
  transaction: Transaction;
  sorter: Sorter<Transaction, TransactionHeaders>;
}

const TransactionRow = ({ transaction, sorter }: Props) => {
  const {
    transaction_id,
    account_id,
    authorized_date,
    date,
    merchant_name,
    name,
    amount,
    label,
  } = transaction;

  const { getVisible } = sorter;

  const { setTransactions, accounts, budgets, sections, categories } = useAppContext();

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(label.budget_id);
  const [selectedCategoryIdLabel, setSelectedCategoryIdLabel] = useState(
    label.category_id
  );

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option
          key={`transaction_${transaction_id}_budget_option_${e.budget_id}`}
          value={e.budget_id}
        >
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [transaction_id, budgets]);

  const categoryOptions = useMemo(() => {
    const availableCategories: Category[] = [];
    sections.forEach((section) => {
      if (section.budget_id !== label.budget_id) return;
      categories.forEach((category) => {
        if (category.section_id !== section.section_id) return;
        availableCategories.push(category);
      });
    });

    return availableCategories.map((e) => {
      return (
        <option
          key={`transaction_${transaction_id}_category_option_${e.category_id}`}
          value={e.category_id}
        >
          {e.name}
        </option>
      );
    });
  }, [transaction_id, label.budget_id, sections, categories]);

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (!value) return;

    setSelectedBudgetIdLabel(value);

    const r = await call.post("/api/transaction", {
      transaction_id,
      label: { budget_id: value },
    });

    if (r.status === "success") {
      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        const newTransaction = { ...transaction };
        newTransaction.label.budget_id = value;
        newTransactions.set(transaction_id, newTransaction);
        return newTransactions;
      });
    } else {
      setSelectedBudgetIdLabel(selectedBudgetIdLabel);
    }
  };

  const onChangeCategorySelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (!value) return;

    setSelectedCategoryIdLabel(value);

    const r = await call.post("/api/transaction", {
      transaction_id,
      label: { category_id: value },
    });

    if (r.status === "success") {
      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        const newTransaction = { ...transaction };
        newTransaction.label.category_id = value;
        newTransactions.set(transaction_id, newTransaction);
        return newTransactions;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  return (
    <tr>
      {getVisible("authorized_date") && (
        <td>
          <div>
            {new Date(authorized_date || date).toLocaleString("en-US", {
              year: "numeric",
              month: "numeric",
              day: "numeric",
            })}
          </div>
        </td>
      )}
      {getVisible("merchant_name") && (
        <td>
          <div>{merchant_name || name}</div>
        </td>
      )}
      {getVisible("amount") && (
        <td>
          <div>{numberToCommaString(-amount)}</div>
        </td>
      )}
      {getVisible("account") && (
        <td>
          <div>{account?.name}</div>
        </td>
      )}
      {getVisible("institution") && (
        <td>
          <div>
            <InstitutionSpan institution_id={institution_id} />
          </div>
        </td>
      )}
      {getVisible("budget") && (
        <td>
          <div>
            <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
              <option value="">Select Budget</option>
              {budgetOptions}
            </select>
          </div>
        </td>
      )}
      {getVisible("category") && (
        <td>
          <div>
            <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
              <option value="">Select Category</option>
              {categoryOptions}
            </select>
          </div>
        </td>
      )}
    </tr>
  );
};

export default TransactionRow;
