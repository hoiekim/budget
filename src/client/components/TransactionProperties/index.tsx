import { ChangeEventHandler, useMemo, useState } from "react";
import {
  Category,
  currencyCodeToSymbol,
  Data,
  numberToCommaString,
  SplitTransaction,
  SplitTransactionDictionary,
  Transaction,
  TransactionDictionary,
  TransactionLabel,
} from "common";
import { useAppContext, call } from "client";
import { InstitutionSpan } from "client/components";

import "./index.css";
import SplitTransactionRow from "./SplitTransactionRow";
import { NewSplitTransactionGetResponse } from "server";

interface Props {
  transaction: Transaction;
}

export const TransactionProperties = ({ transaction }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts, budgets, sections, categories } = data;

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

  const remainingAmount = transaction.getRemainingAmount();

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ transaction_id, account_id }).toString();
    const newSplitTransactionResponse = await call.get<NewSplitTransactionGetResponse>(
      "/api/new-split-transaction" + queryString
    );
    if (!newSplitTransactionResponse.body) {
      console.error("Failed to get a new split transaction id:", newSplitTransactionResponse);
      return;
    }
    const { split_transaction_id } = newSplitTransactionResponse.body;
    const newSplitTransaction = new SplitTransaction({
      split_transaction_id,
      transaction_id,
      account_id,
      date,
      amount: +(remainingAmount / 2).toFixed(2),
      label,
    });

    await call.post("/api/split-transaction", newSplitTransaction);

    setData((oldData) => {
      const newData = new Data(oldData);
      const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
      newSplitTransactions.set(newSplitTransaction.split_transaction_id, newSplitTransaction);
      newData.splitTransactions = newSplitTransactions;
      return newData;
    });
  };

  const splitTransactionInputRows = transaction
    .getChildren()
    .toArray()
    .map((s) => {
      return (
        <div key={s.id} className="row">
          <SplitTransactionRow splitTransaction={s} />
        </div>
      );
    });

  const { city, region, country } = location;
  const locations = [city, region, country].filter((e) => e);

  const sectionName =
    label.category_id && categories.get(label.category_id)
      ? sections.get(categories.get(label.category_id)!.section_id)?.name
      : "";

  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const isIncome = transaction.amount < 0;

  return (
    <div className="TransactionProperties Properties">
      <div className="propertyLabel">Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Date</span>
          <span>
            {new Date(authorized_date || date).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Merchant&nbsp;Name</span>
          <span>{merchant_name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          <span>{name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Amount</span>
          <span>
            {isIncome && <>+&nbsp;</>}
            {currencySymbol}&nbsp;
            {numberToCommaString(Math.abs(amount))}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Location</span>
          <span>{locations.join(", ")}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Account</span>
          <span>{account?.custom_name || account?.name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Institution</span>
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </div>
      </div>
      {!splitTransactionInputRows.length && (
        <>
          <div className="propertyLabel">Budgets</div>
          <div className="property">
            <div className="row keyValue">
              <span className="propertyName">Budget</span>
              <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                <option value="">Select Budget</option>
                {budgetOptions}
              </select>
            </div>
            <div className="row keyValue">
              <span className="propertyName">Section</span>
              <span>{sectionName}</span>
            </div>
            <div className="row keyValue">
              <span className="propertyName">Category</span>
              <div className={selectedCategoryIdLabel ? "" : "notification"}>
                <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
                  <option value="">Select Category</option>
                  {categoryOptions}
                </select>
              </div>
            </div>
          </div>
        </>
      )}
      <div className="propertyLabel">Split&nbsp;Transactions</div>
      <div className="property">
        {splitTransactionInputRows}
        {!!splitTransactionInputRows.length && (
          <div className="row">
            <div className="SplitTransactionRow">
              <div className="amount">
                <span>
                  {isIncome && <>+&nbsp;</>}
                  {currencySymbol}&nbsp;
                  {numberToCommaString(Math.abs(remainingAmount))}
                </span>
              </div>
              <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                <option value="">Select Budget</option>
                {budgetOptions}
              </select>
              <div className={selectedCategoryIdLabel ? "" : "notification"}>
                <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
                  <option value="">Select Category</option>
                  {categoryOptions}
                </select>
              </div>
            </div>
          </div>
        )}
        <div className="row button">
          <button onClick={onClickAdd}>Add&nbsp;New&nbsp;Split</button>
        </div>
      </div>
    </div>
  );
};
