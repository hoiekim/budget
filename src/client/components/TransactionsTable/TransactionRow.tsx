import { useState, useEffect, ChangeEventHandler, useMemo } from "react";
import { Category, Transaction, TransactionLabel } from "server";
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
    location,
  } = transaction;

  const { getVisible } = sorter;

  const { setTransactions, accounts, budgets, sections, categories } = useAppContext();

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || account?.label.budget_id;
  });
  const [selectedCategoryIdLabel, setSelectedCategoryIdLabel] = useState(
    label.category_id
  );

  useEffect(() => {
    if (label.budget_id) return;
    setSelectedBudgetIdLabel(account?.label.budget_id);
  }, [label.budget_id, account?.label.budget_id]);

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
      const budget_id = label.budget_id || account?.label.budget_id;
      if (section.budget_id !== budget_id) return;
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
  }, [transaction_id, label.budget_id, account?.label.budget_id, sections, categories]);

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (!value || value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel(undefined);

    const r = await call.post("/api/transaction", {
      transaction_id,
      label: { budget_id: value, category_id: null },
    });

    if (r.status === "success") {
      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        const newTransaction = { ...transaction };
        newTransaction.label.budget_id = value;
        delete newTransaction.label.category_id;
        newTransactions.set(transaction_id, newTransaction);
        return newTransactions;
      });
    } else {
      setSelectedBudgetIdLabel(selectedBudgetIdLabel);
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const onChangeCategorySelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (!value) return;

    setSelectedCategoryIdLabel(value);

    const labelQuery: TransactionLabel = { category_id: value };
    if (!label.budget_id) labelQuery.budget_id = account?.label.budget_id;

    const r = await call.post("/api/transaction", { transaction_id, label: labelQuery });

    if (r.status === "success") {
      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        const newTransaction = { ...transaction };
        if (!newTransaction.label.budget_id) {
          newTransaction.label.budget_id = account?.label.budget_id;
        }
        newTransaction.label.category_id = value;
        newTransactions.set(transaction_id, newTransaction);
        return newTransactions;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const { city, region, country } = location;
  const locations = [city, region || country].filter((e) => e);

  return (
    <div className="TransactionRow">
      <div className="transactionInfo">
        {getVisible("authorized_date") && (
          <div className="authorized_date bigText">
            {new Date(authorized_date || date).toLocaleString("en-US", {
              month: "numeric",
              day: "numeric",
            })}
          </div>
        )}
        <div className="merchant_name">
          {getVisible("merchant_name") && (
            <>
              {merchant_name && <div className="bigText">{merchant_name}</div>}
              {name && <div className="smallText">{name}</div>}
              {!!locations.length && (
                <div className="smallText">{locations.join(", ")}</div>
              )}
            </>
          )}
          {getVisible("account") && (
            <>
              <div className="bigText">{account?.custom_name || account?.name}</div>
              <div className="smallText">
                <InstitutionSpan institution_id={institution_id} />
              </div>
            </>
          )}
        </div>
        {getVisible("amount") && (
          <div className="amount">{numberToCommaString(-amount)}</div>
        )}
      </div>
      <div className="budgetCategory">
        {getVisible("budget") && (
          <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
            <option value="">Select Budget</option>
            {budgetOptions}
          </select>
        )}
        {getVisible("category") && (
          <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
            <option value="">Select Category</option>
            {categoryOptions}
          </select>
        )}
      </div>
    </div>
  );
};

export default TransactionRow;
