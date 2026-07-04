import { ChangeEventHandler, useEffect, useState } from "react";
import { currencyCodeToSymbol, LocalDate, numberToCommaString, toTitleCase } from "common";
import {
  Data,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  TransactionLabel,
  useAppContext,
  useBudgetCategorySelect,
  call,
  indexedDb,
} from "client";
import { InstitutionSpan } from "client/components";

interface Props {
  investmentTransaction: InvestmentTransaction;
}

export const InvestmentTransactionProperties = ({ investmentTransaction }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts, sections, categories, securities } = data;

  const {
    investment_transaction_id,
    account_id,
    security_id,
    date,
    name,
    amount,
    quantity,
    price,
    iso_currency_code,
    type,
    subtype,
    label,
  } = investmentTransaction;

  const account = accounts.get(account_id);
  const security = security_id ? securities.get(security_id) : null;

  const {
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    selectedCategoryIdLabel,
    setSelectedCategoryIdLabel,
    budgetOptions,
    categoryOptions,
  } = useBudgetCategorySelect(label, account, `investment_transaction_${investment_transaction_id}`);

  useEffect(() => {
    setSelectedBudgetIdLabel(label.budget_id || account?.label.budget_id || "");
    setSelectedCategoryIdLabel(label.category_id || "");
  }, [label, account, setSelectedBudgetIdLabel, setSelectedCategoryIdLabel]);

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;
    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel("");

    const r = await call.post("/api/investment-transaction", {
      investment_transaction_id,
      label: { budget_id: value || null, category_id: null, category_confidence: 0 },
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const updated = new InvestmentTransaction(investmentTransaction);
        updated.label.budget_id = value || null;
        updated.label.category_id = null;
        updated.label.category_confidence = 0;
        indexedDb.save(updated).catch(console.error);
        const newDict = new InvestmentTransactionDictionary(newData.investmentTransactions);
        newDict.set(investment_transaction_id, updated);
        newData.investmentTransactions = newDict;
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
    const nextConfidence = value ? 1 : 0;
    const labelQuery = new TransactionLabel({
      category_id: value || null,
      category_confidence: nextConfidence,
    });
    if (!label.budget_id) labelQuery.budget_id = account?.label.budget_id;

    const r = await call.post("/api/investment-transaction", {
      investment_transaction_id,
      label: labelQuery,
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const updated = new InvestmentTransaction(investmentTransaction);
        if (!updated.label.budget_id) updated.label.budget_id = account?.label.budget_id;
        updated.label.category_id = value || null;
        updated.label.category_confidence = nextConfidence;
        indexedDb.save(updated).catch(console.error);
        const newDict = new InvestmentTransactionDictionary(newData.investmentTransactions);
        newDict.set(investment_transaction_id, updated);
        newData.investmentTransactions = newDict;
        return newData;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const [memoValue, setMemoValue] = useState(label.memo ?? "");
  useEffect(() => {
    setMemoValue(label.memo ?? "");
  }, [investment_transaction_id, label.memo]);

  const onChangeMemo: ChangeEventHandler<HTMLInputElement> = (e) => {
    setMemoValue(e.target.value);
  };

  const onBlurMemo = async () => {
    const trimmed = memoValue.trim();
    const current = label.memo ?? "";
    if (trimmed === current) return;
    const newMemo = trimmed || null;
    const r = await call.post("/api/investment-transaction", {
      investment_transaction_id,
      label: { memo: newMemo },
    });
    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newDict = new InvestmentTransactionDictionary(oldData.investmentTransactions);
        const existing = newDict.get(investment_transaction_id);
        if (existing) {
          const updated = new InvestmentTransaction(existing);
          updated.label.memo = newMemo;
          newDict.set(investment_transaction_id, updated);
        }
        newData.investmentTransactions = newDict;
        return newData;
      });
    }
  };

  const sectionName = (() => {
    const cat = selectedCategoryIdLabel ? categories.get(selectedCategoryIdLabel) : null;
    const sec = cat?.section_id ? sections.get(cat.section_id) : null;
    return sec?.name ?? "";
  })();

  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "USD");

  return (
    <div className="InvestmentTransactionProperties Properties">
      <div className="propertyLabel">Investment&nbsp;Transaction&nbsp;Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Date</span>
          <span>
            {new LocalDate(date).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          <span>{name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Security</span>
          <span>{security?.name || "—"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Ticker</span>
          <span>{security?.ticker_symbol || "—"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Type</span>
          <span>{toTitleCase(type)}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Subtype</span>
          <span>{toTitleCase(subtype)}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Quantity</span>
          <span>{numberToCommaString(quantity)}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Price</span>
          <span>
            {currencySymbol}&nbsp;{numberToCommaString(price)}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Amount</span>
          <span>
            {currencySymbol}&nbsp;{numberToCommaString(amount)}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Account</span>
          <span>{account?.custom_name || account?.name}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Institution</span>
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Memo</span>
          <input
            type="text"
            value={memoValue}
            placeholder="Add a note…"
            onChange={onChangeMemo}
            onBlur={onBlurMemo}
          />
        </div>
      </div>
      <div className="propertyLabel">Budgets</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Budget</span>
          <div>
            <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
              <option value="">Select Budget</option>
              {budgetOptions}
            </select>
          </div>
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
    </div>
  );
};
