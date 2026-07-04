import { ChangeEventHandler, useEffect, useState } from "react";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
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
import type { ValidateTickerResponse } from "server";

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
    source,
  } = investmentTransaction;
  const isManual = source === "manual";

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

  // Manual-row inline editing (#585). Plaid rows keep the read-only
  // `<span>` display below; only `source === 'manual'` unlocks these
  // inputs so we never overwrite a Plaid-synced field.
  const [nameValue, setNameValue] = useState(name ?? "");
  const [dateValue, setDateValue] = useState((date || "").slice(0, 10));
  const [quantityValue, setQuantityValue] = useState(String(quantity ?? 0));
  const [priceValue, setPriceValue] = useState(String(price ?? 0));
  const [amountValue, setAmountValue] = useState(String(amount ?? 0));
  const [tickerValue, setTickerValue] = useState(security?.ticker_symbol ?? "");
  const [tickerMessage, setTickerMessage] = useState<string | null>(null);
  useEffect(() => {
    setNameValue(name ?? "");
    setDateValue((date || "").slice(0, 10));
    setQuantityValue(String(quantity ?? 0));
    setPriceValue(String(price ?? 0));
    setAmountValue(String(amount ?? 0));
    setTickerValue(security?.ticker_symbol ?? "");
  }, [investment_transaction_id, name, date, quantity, price, amount, security?.ticker_symbol]);

  const persistInvTxField = async (patch: Partial<InvestmentTransaction>) => {
    const r = await call.post("/api/investment-transaction", {
      investment_transaction_id,
      ...patch,
    });
    if (r.status !== "success") return false;
    setData((oldData) => {
      const newData = new Data(oldData);
      const dict = new InvestmentTransactionDictionary(oldData.investmentTransactions);
      const existing = dict.get(investment_transaction_id);
      if (existing) {
        const updated = new InvestmentTransaction(existing);
        Object.assign(updated, patch);
        indexedDb.save(updated).catch(console.error);
        dict.set(investment_transaction_id, updated);
      }
      newData.investmentTransactions = dict;
      return newData;
    });
    return true;
  };

  const onBlurName = async () => {
    if (!isManual || nameValue === (name ?? "")) return;
    await persistInvTxField({ name: nameValue });
  };
  const onBlurDate = async () => {
    if (!isManual || !dateValue || dateValue === (date || "").slice(0, 10)) return;
    await persistInvTxField({ date: dateValue });
  };
  const onBlurQuantity = async () => {
    if (!isManual) return;
    const parsed = parseFloat(quantityValue);
    if (!Number.isFinite(parsed) || parsed === quantity) {
      setQuantityValue(String(quantity ?? 0));
      return;
    }
    await persistInvTxField({ quantity: parsed });
  };
  const onBlurPrice = async () => {
    if (!isManual) return;
    const parsed = parseFloat(priceValue);
    if (!Number.isFinite(parsed) || parsed === price) {
      setPriceValue(String(price ?? 0));
      return;
    }
    await persistInvTxField({ price: parsed });
  };
  const onBlurAmount = async () => {
    if (!isManual) return;
    const parsed = parseFloat(amountValue);
    if (!Number.isFinite(parsed) || parsed === amount) {
      setAmountValue(String(amount ?? 0));
      return;
    }
    await persistInvTxField({ amount: parsed });
  };
  const onChangeType: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    if (!isManual) return;
    const value = e.target.value as InvestmentTransactionType;
    await persistInvTxField({ type: value });
  };
  const onChangeSubtype: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    if (!isManual) return;
    const value = e.target.value as InvestmentTransactionSubtype;
    await persistInvTxField({ subtype: value });
  };
  // Ticker → security_id resolution mirrors HoldingProperties'
  // `POST /api/validate-ticker` flow. Body field is `ticker_symbol`
  // (matches the route's requireStringField); response wraps the
  // security under `body.security` when `body.valid === true`. On
  // blur, if the ticker resolves, patch `security_id`; otherwise
  // surface the server's validation message and leave the field
  // untouched.
  const onBlurTicker = async () => {
    if (!isManual) return;
    const raw = tickerValue.trim();
    if (!raw || raw === (security?.ticker_symbol ?? "")) {
      setTickerMessage(null);
      return;
    }
    const r = await call.post<ValidateTickerResponse>("/api/validate-ticker", {
      ticker_symbol: raw,
    });
    if (r.status === "success" && r.body?.valid && r.body.security) {
      setTickerMessage(r.body.security.name ?? "Valid ticker");
      await persistInvTxField({ security_id: r.body.security.security_id });
    } else {
      setTickerMessage(r.body?.message ?? r.message ?? "Invalid ticker");
    }
  };

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
          {isManual ? (
            <input
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              onBlur={onBlurDate}
            />
          ) : (
            <span>
              {new LocalDate(date).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Name</span>
          {isManual ? (
            <input
              type="text"
              value={nameValue}
              placeholder="e.g. RSU grant"
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={onBlurName}
            />
          ) : (
            <span>{name}</span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Security</span>
          <span>{security?.name || "—"}</span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Ticker</span>
          {isManual ? (
            <input
              type="text"
              value={tickerValue}
              placeholder="e.g. VOO"
              onChange={(e) => setTickerValue(e.target.value.toUpperCase())}
              onBlur={onBlurTicker}
            />
          ) : (
            <span>{security?.ticker_symbol || "—"}</span>
          )}
        </div>
        {isManual && tickerMessage && (
          <div className="row keyValue">
            <span className="propertyName">&nbsp;</span>
            <span>{tickerMessage}</span>
          </div>
        )}
        <div className="row keyValue">
          <span className="propertyName">Type</span>
          {isManual ? (
            <select value={type} onChange={onChangeType}>
              {Object.values(InvestmentTransactionType).map((v) => (
                <option key={v} value={v}>
                  {toTitleCase(v)}
                </option>
              ))}
            </select>
          ) : (
            <span>{toTitleCase(type)}</span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Subtype</span>
          {isManual ? (
            <select value={subtype} onChange={onChangeSubtype}>
              {Object.values(InvestmentTransactionSubtype).map((v) => (
                <option key={v} value={v}>
                  {toTitleCase(v)}
                </option>
              ))}
            </select>
          ) : (
            <span>{toTitleCase(subtype)}</span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Quantity</span>
          {isManual ? (
            <input
              type="number"
              step="any"
              value={quantityValue}
              onChange={(e) => setQuantityValue(e.target.value)}
              onBlur={onBlurQuantity}
            />
          ) : (
            <span>{numberToCommaString(quantity)}</span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Price</span>
          {isManual ? (
            <input
              type="number"
              step="any"
              value={priceValue}
              onChange={(e) => setPriceValue(e.target.value)}
              onBlur={onBlurPrice}
            />
          ) : (
            <span>
              {currencySymbol}&nbsp;{numberToCommaString(price)}
            </span>
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Amount</span>
          {isManual ? (
            <input
              type="number"
              step="0.01"
              value={amountValue}
              onChange={(e) => setAmountValue(e.target.value)}
              onBlur={onBlurAmount}
            />
          ) : (
            <span>
              {currencySymbol}&nbsp;{numberToCommaString(amount)}
            </span>
          )}
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
