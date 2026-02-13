import { useState, useEffect, ChangeEventHandler, useMemo } from "react";
import { currencyCodeToSymbol } from "common";
import {
  TransactionLabel,
  Category,
  Data,
  SplitTransactionDictionary,
  SplitTransaction,
  useAppContext,
  call,
  indexedDb,
  StoreName,
} from "client";
import { CapacityInput } from "client/components";

interface Props {
  splitTransaction: SplitTransaction;
}

const SplitTransactionRow = ({ splitTransaction }: Props) => {
  const { split_transaction_id, transaction_id, amount, label } = splitTransaction;

  const { data, setData } = useAppContext();
  const { transactions, accounts, budgets, sections, categories } = data;

  const transaction = transactions.get(transaction_id)!;
  const account = accounts.get(transaction.account_id)!;

  const { iso_currency_code } = transaction;

  const isIncome = transaction.amount < 0;

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || account?.label.budget_id || "";
  });
  const [selectedCategoryIdLabel, setSelectedCategoryIdLabel] = useState(() => {
    return label.category_id || "";
  });

  useEffect(() => {
    if (label.budget_id) return;
    setSelectedBudgetIdLabel(account?.label.budget_id || "");
  }, [label.budget_id, account?.label.budget_id]);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option
          key={`split_transaction_${split_transaction_id}_budget_option_${e.budget_id}`}
          value={e.budget_id}
        >
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [split_transaction_id, budgets]);

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
          key={`split_transaction_${split_transaction_id}_category_option_${e.category_id}`}
          value={e.category_id}
        >
          {e.name}
        </option>
      );
    });
  }, [split_transaction_id, label.budget_id, account?.label.budget_id, sections, categories]);

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel("");

    const r = await call.post("/api/split-transaction", {
      split_transaction_id,
      label: { budget_id: value || null, category_id: null },
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newSplit = new SplitTransaction(splitTransaction);
        newSplit.label.budget_id = value || null;
        newSplit.label.category_id = null;
        indexedDb.save(newSplit).catch(console.error);
        const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
        newSplits.set(split_transaction_id, newSplit);
        newData.splitTransactions = newSplits;
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

    const r = await call.post("/api/split-transaction", {
      split_transaction_id,
      label: labelQuery,
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newSplit = new SplitTransaction(splitTransaction);
        if (!newSplit.label.budget_id) {
          newSplit.label.budget_id = account?.label.budget_id;
        }
        newSplit.label.category_id = value || null;
        indexedDb.save(newSplit).catch(console.error);
        const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
        newSplits.set(split_transaction_id, newSplit);
        newData.splitTransactions = newSplits;
        return newData;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const onChangeAmount: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const abs = Math.abs(+e.target.value || 0);

    if (!abs) {
      await call.delete(`/api/split-transaction?id=${split_transaction_id}`);
      setData((oldData) => {
        const newData = new Data(oldData);
        indexedDb.remove(StoreName.splitTransactions, split_transaction_id).catch(console.error);
        const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
        newSplits.delete(split_transaction_id);
        newData.splitTransactions = newSplits;
        return newData;
      });
      return;
    }

    const newAmount = abs * (isIncome ? -1 : 1);

    await call.post("/api/split-transaction", { split_transaction_id, amount: newAmount });
    setData((oldData) => {
      const newData = new Data(oldData);
      const newSplit = new SplitTransaction(splitTransaction);
      newSplit.amount = newAmount;
      indexedDb.save(newSplit).catch(console.error);
      const newSplits = new SplitTransactionDictionary(newData.splitTransactions);
      newSplits.set(split_transaction_id, newSplit);
      newData.splitTransactions = newSplits;
      return newData;
    });
  };

  return (
    <div className="SplitTransactionRow">
      <div className="amount">
        {isIncome && <>+&nbsp;</>}
        {currencyCodeToSymbol(iso_currency_code || "")}&nbsp;
        <CapacityInput defaultValue={Math.abs(amount)} fixed={2} onBlur={onChangeAmount} />
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
  );
};

export default SplitTransactionRow;
