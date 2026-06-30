import { useEffect, ChangeEventHandler } from "react";
import { currencyCodeToSymbol } from "common";
import {
  TransactionLabel,
  Data,
  SplitTransactionDictionary,
  SplitTransaction,
  useAppContext,
  useBudgetCategorySelect,
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
  const { transactions, accounts } = data;

  const transaction = transactions.get(transaction_id)!;
  const account = accounts.get(transaction.account_id)!;

  const { iso_currency_code } = transaction;

  const isIncome = transaction.amount < 0;

  const {
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    selectedCategoryIdLabel,
    setSelectedCategoryIdLabel,
    budgetOptions,
    categoryOptions,
  } = useBudgetCategorySelect(label, account, `split_transaction_${split_transaction_id}`);

  useEffect(() => {
    if (label.budget_id) return;
    setSelectedBudgetIdLabel(account?.label.budget_id || "");
  }, [label.budget_id, account?.label.budget_id, setSelectedBudgetIdLabel]);

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
        // Local IndexedDB write must mirror the server's confidence
        // inference (`inferLabelConfidence`, `lib/infer-label-confidence.ts`)
        // — otherwise the UI flashes the stale prior `c_conf` value until
        // the next reload (#415). Budget-only edit always clears the
        // category, so confidence resets to 0.
        newSplit.label.category_confidence = 0;
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
        // Mirror server-side `inferLabelConfidence`: 1 = picked a category,
        // 0 = cleared. Without this, IndexedDB carries the stale prior
        // confidence on the local row until next reload (#415).
        newSplit.label.category_confidence = +!!value;
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
      const deleteResponse = await call.delete(
        `/api/split-transaction?id=${split_transaction_id}`,
      );
      if (deleteResponse.status !== "success") {
        console.error("Failed to delete split transaction:", deleteResponse.message);
        return;
      }
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

    const updateResponse = await call.post("/api/split-transaction", {
      split_transaction_id,
      amount: newAmount,
    });
    if (updateResponse.status !== "success") {
      console.error("Failed to update split transaction amount:", updateResponse.message);
      return;
    }
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
