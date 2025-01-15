import { ChangeEventHandler, useEffect, useMemo, useState } from "react";
import {
  Category,
  currencyCodeToSymbol,
  Data,
  SplitTransaction,
  Transaction,
  TransactionDictionary,
  TransactionLabel,
} from "common";
import { useAppContext, call } from "client";
import { CapacityInput, InstitutionSpan } from "client/components";

import "./index.css";

interface Props {
  transaction: Transaction;
}

const TransactionProperties = ({ transaction }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts, transactions, splitTransactions, budgets, sections, categories } = data;

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
    iso_currency_code,
  } = transaction;

  const account = accounts.get(account_id);

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || account?.label.budget_id || "";
  });
  const [selectedCategoryIdLabel, setSelectedCategoryIdLabel] = useState(() => {
    return label.category_id || "";
  });

  const defaultSplitTransactionInputs = splitTransactions.filterBy({ transaction_id });
  const [splitTransactionInputs, setSplitTransactionInputs] = useState<SplitTransaction[]>(
    defaultSplitTransactionInputs
  );

  useEffect(() => {
    const newSplitTransactionInputs = splitTransactions.filterBy({ transaction_id });
    setSplitTransactionInputs(newSplitTransactionInputs);
  }, [transaction_id, transactions, splitTransactions]);

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
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel("");

    const r = await call.post("/api/transaction", {
      transaction_id,
      label: { budget_id: value || null, category_id: null },
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newTransaction = new Transaction(transaction);
        const newTransactions = new TransactionDictionary(newData.transactions);
        newTransaction.label.budget_id = value || null;
        newTransaction.label.category_id = null;
        newTransactions.set(transaction_id, newTransaction);
        newData.transactions = newTransactions;
        return newData;
      });
    } else {
      setSelectedBudgetIdLabel(selectedBudgetIdLabel);
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const onChangeCategorySelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedCategoryIdLabel) return;

    setSelectedCategoryIdLabel(value);
    const labelQuery = new TransactionLabel({ category_id: value || null });
    if (!label.budget_id) labelQuery.budget_id = account?.label.budget_id;

    const r = await call.post("/api/transaction", { transaction_id, label: labelQuery });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newTransaction = new Transaction(transaction);
        const newTransactions = new TransactionDictionary(newData.transactions);
        if (!newTransaction.label.budget_id) {
          newTransaction.label.budget_id = account?.label.budget_id;
        }
        newTransaction.label.category_id = value || null;
        newTransactions.set(transaction_id, newTransaction);
        newData.transactions = newTransactions;
        return newData;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const onClickAdd = () => {
    setSplitTransactionInputs((oldState) => {
      const newSplitTransaction = new SplitTransaction({
        transaction_id,
        amount: amount / 2,
      });
      return [...oldState, newSplitTransaction];
    });
  };

  const splitTransactionInputRows = splitTransactionInputs.map((s, i) => {
    const { budget_id, category_id } = s.label;
    const budget = selectedCategoryIdLabel;
    const category = typeof category_id === "string" ? data.categories.get(category_id) : undefined;
    return (
      <div key={i} className="row">
        <div className="splitItem">
          <CapacityInput
            style={{ width: `${"000,000".length}ch` }}
            defaultValue={s.amount}
            onBlur={() => {}}
          />
          <span>{selectedBudgetIdLabel}</span>
          <span>{selectedCategoryIdLabel}</span>
        </div>
      </div>
    );
  });

  const { city, region, country } = location;
  const locations = [city, region, country].filter((e) => e);

  const sectionName =
    label.category_id && categories.get(label.category_id)
      ? sections.get(categories.get(label.category_id)!.section_id)?.name
      : "";

  return (
    <div className="TransactionProperties Properties">
      <div className="property">
        <div className="row">
          <span className="propertyName">Date</span>
          <span>
            {new Date(authorized_date || date).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="row">
          <span className="propertyName">Merchant&nbsp;Name</span>
          <span>{merchant_name}</span>
        </div>
        <div className="row">
          <span className="propertyName">Name</span>
          <span>{name}</span>
        </div>
        <div className="row">
          <span className="propertyName">Amount</span>
          <span>
            {currencyCodeToSymbol(iso_currency_code || "")}&nbsp;{amount}
          </span>
        </div>
        <div className="row">
          <span className="propertyName">Location</span>
          <span>{locations.join(", ")}</span>
        </div>
        <div className="row">
          <span className="propertyName">Account</span>
          <span>{account?.custom_name || account?.name}</span>
        </div>
        <div className="row">
          <span className="propertyName">Institution</span>
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </div>
      </div>
      <div className="property">
        <div className="row">
          <span className="propertyName">Budget</span>
          <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
            <option value="">Select Budget</option>
            {budgetOptions}
          </select>
        </div>
        <div className="row">
          <span className="propertyName">Section</span>
          <span>{sectionName}</span>
        </div>
        <div className="row">
          <span className="propertyName">Category</span>
          <div className={selectedCategoryIdLabel ? "" : "notification"}>
            <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
              <option value="">Select Category</option>
              {categoryOptions}
            </select>
          </div>
        </div>
      </div>
      <div className="property">
        <div className="row addNew">
          <button disabled className="disabled" onClick={onClickAdd}>
            Add&nbsp;New&nbsp;Split
          </button>
        </div>
        {splitTransactionInputRows}
      </div>
    </div>
  );
};

export default TransactionProperties;
