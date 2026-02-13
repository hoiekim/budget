import { useState, useEffect, ChangeEventHandler, useMemo } from "react";
import { numberToCommaString, currencyCodeToSymbol, LocalDate } from "common";
import {
  useAppContext,
  call,
  PATH,
  Transaction,
  TransactionLabel,
  Category,
  Data,
  TransactionDictionary,
  SplitTransaction,
  SplitTransactionDictionary,
  indexedDb,
} from "client";
import { InstitutionSpan, KebabIcon } from "client/components";
import { ApiResponse } from "server";

interface Props {
  transaction: Transaction | SplitTransaction;
}

const TransactionRow = ({ transaction }: Props) => {
  const { data, calculations, setData, router } = useAppContext();
  const { transactionFamilies } = calculations;
  const { id, transaction_id, amount, label } = transaction;
  const parentTransaction = data.transactions.get(transaction_id)!;
  const { account_id, authorized_date, date, merchant_name, name, location, iso_currency_code } =
    parentTransaction;
  const amountAfterSplit = amount - transactionFamilies.getChildrenAmountTotal(id);

  const { accounts, budgets, sections, categories } = data;
  const { path, go } = router;

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

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
        <option key={`transaction_${id}_budget_option_${e.budget_id}`} value={e.budget_id}>
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [id, budgets]);

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
        <option key={`transaction_${id}_category_option_${e.category_id}`} value={e.category_id}>
          {e.name}
        </option>
      );
    });
  }, [id, label.budget_id, account?.label.budget_id, sections, categories]);

  const isSplitTransaction = transaction instanceof SplitTransaction;

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel("");

    let response: ApiResponse;
    if (isSplitTransaction) {
      response = await call.post("/api/split-transaction", {
        split_transaction_id: id,
        label: { budget_id: value || null, category_id: null },
      });
      return;
    } else {
      response = await call.post("/api/transaction", {
        transaction_id: id,
        label: { budget_id: value || null, category_id: null },
      });
    }

    if (response.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        if (isSplitTransaction) {
          const newSplitTransaction = new SplitTransaction(parentTransaction);
          newSplitTransaction.label.budget_id = value || null;
          newSplitTransaction.label.category_id = null;
          indexedDb.save(newSplitTransaction).catch(console.error);
          const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
          newSplitTransactions.set(id, newSplitTransaction);
          newData.splitTransactions = newSplitTransactions;
        } else {
          const newTransaction = new Transaction(parentTransaction);
          newTransaction.label.budget_id = value || null;
          newTransaction.label.category_id = null;
          indexedDb.save(newTransaction).catch(console.error);
          const newTransactions = new TransactionDictionary(newData.transactions);
          newTransactions.set(id, newTransaction);
          newData.transactions = newTransactions;
        }
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

    let response: ApiResponse;
    if (isSplitTransaction) {
      response = await call.post("/api/split-transaction", {
        split_transaction_id: id,
        label: labelQuery,
      });
    } else {
      response = await call.post("/api/transaction", {
        transaction_id: id,
        label: labelQuery,
      });
    }

    if (response.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        if (isSplitTransaction) {
          const newSplitTransaction = new SplitTransaction(parentTransaction);
          if (!newSplitTransaction.label.budget_id) {
            newSplitTransaction.label.budget_id = account?.label.budget_id;
          }
          newSplitTransaction.label.category_id = value || null;
          indexedDb.save(newSplitTransaction).catch(console.error);
          const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
          newSplitTransactions.set(id, newSplitTransaction);
          newData.splitTransactions = newSplitTransactions;
        } else {
          const newTransaction = new Transaction(parentTransaction);
          if (!newTransaction.label.budget_id) {
            newTransaction.label.budget_id = account?.label.budget_id;
          }
          newTransaction.label.category_id = value || null;
          indexedDb.save(newTransaction).catch(console.error);
          const newTransactions = new TransactionDictionary(newData.transactions);
          newTransactions.set(id, newTransaction);
          newData.transactions = newTransactions;
        }
        return newData;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const onClickKebab = () => {
    if (path === PATH.TRANSACTION_DETAIL) return;
    const params = new URLSearchParams(router.params);
    params.set("transaction_id", parentTransaction.transaction_id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  const { city, region, country } = location;
  const locations = [city, region, country].filter((e) => e);

  return (
    <div className="TransactionRow">
      <div className="transactionInfo">
        <div className="authorized_date bigText">
          {new LocalDate(authorized_date || date).toLocaleString("en-US", {
            month: "numeric",
            day: "numeric",
          })}
        </div>
        <div className="merchant_name">
          {merchant_name && <div className="bigText">{merchant_name}</div>}
          {name && <div className="smallText">{name}</div>}
          {!!locations.length && <div className="smallText">{locations.join(", ")}</div>}

          <div className="bigText">{account?.custom_name || account?.name}</div>
          <div className="smallText">
            {institution_id && <InstitutionSpan institution_id={institution_id} />}
          </div>
        </div>
        <div className="amount">
          {amountAfterSplit < 0 && <>+&nbsp;</>}
          {currencyCodeToSymbol(iso_currency_code || "")}&nbsp;
          {numberToCommaString(Math.abs(amountAfterSplit))}
        </div>
      </div>
      <div className="budgetCategoryActions">
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
        <div>
          <button className="kebabButton" onClick={onClickKebab}>
            <KebabIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TransactionRow;
