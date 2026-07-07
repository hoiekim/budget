import { ChangeEventHandler, useMemo, useState, useEffect } from "react";
import {
  currencyCodeToSymbol,
  LocalDate,
  numberToCommaString,
  TRANSFER_DATE_WINDOW_DAYS as PARTNER_DATE_WINDOW_DAYS,
} from "common";
import { NewSplitTransactionGetResponse } from "server";
import {
  Data,
  SplitTransaction,
  SplitTransactionDictionary,
  StoreName,
  Transaction,
  TransactionDictionary,
  TransactionLabel,
  useAppContext,
  useBudgetCategorySelect,
  useTransfers,
  call,
  indexedDb,
} from "client";
import {
  InstitutionSpan,
  Properties,
  Property,
  PropertyLabel,
  Row,
  TransferArrowIcon,
} from "client/components";
import SplitTransactionRow from "./SplitTransactionRow";
import "./index.css";

// Window for the partner-candidate filter — single source of truth in
// `common/transfers.ts` so the FE picker stays in lockstep with the
// detect-transfers cron. Previously this was a separate `const` that
// drifted to 3 days while the cron moved to 7, so engine-surfaced
// partners outside ±3 days couldn't be manually re-paired.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface Props {
  transaction: Transaction;
}

export const TransactionProperties = ({ transaction }: Props) => {
  const { data, setData, calculations, router } = useAppContext();
  const transferActions = useTransfers();
  const { transactionFamilies } = calculations;
  const { accounts, sections, categories, transfers } = data;

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
    source,
  } = transaction;
  const isManual = source === "manual";

  const account = accounts.get(account_id);

  const {
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    selectedCategoryIdLabel,
    setSelectedCategoryIdLabel,
    budgetOptions,
    categoryOptions,
  } = useBudgetCategorySelect(label, account, `transaction_${transaction_id}`);

  useEffect(() => {
    setSelectedBudgetIdLabel(label.budget_id || account?.label.budget_id || "");
    setSelectedCategoryIdLabel(label.category_id || "");
  }, [label, account, setSelectedBudgetIdLabel, setSelectedCategoryIdLabel]);

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
        newTransaction.label.budget_id = value || null;
        newTransaction.label.category_id = null;
        newTransaction.label.category_confidence = 0;
        indexedDb.save(newTransaction).catch(console.error);
        const newTransactions = new TransactionDictionary(newData.transactions);
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
        if (!newTransaction.label.budget_id) {
          newTransaction.label.budget_id = account?.label.budget_id;
        }
        newTransaction.label.category_id = value || null;
        newTransaction.label.category_confidence = +!!value;
        indexedDb.save(newTransaction).catch(console.error);
        const newTransactions = new TransactionDictionary(newData.transactions);
        newTransactions.set(transaction_id, newTransaction);
        newData.transactions = newTransactions;
        return newData;
      });
    } else {
      setSelectedCategoryIdLabel(selectedCategoryIdLabel);
    }
  };

  const [memoValue, setMemoValue] = useState(label.memo ?? "");

  // Sync memo state when the transaction changes (e.g., user selects a different transaction)
  useEffect(() => {
    setMemoValue(label.memo ?? "");
  }, [transaction_id, label.memo]);

  const onChangeMemo: ChangeEventHandler<HTMLInputElement> = (e) => {
    setMemoValue(e.target.value);
  };

  const onBlurMemo = async () => {
    const trimmed = memoValue.trim();
    const current = label.memo ?? "";
    if (trimmed === current) return;
    const newMemo = trimmed || null;
    const r = await call.post("/api/transaction", {
      transaction_id,
      label: { memo: newMemo },
    });
    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newTransactions = new TransactionDictionary(oldData.transactions);
        const existing = newTransactions.get(transaction_id);
        if (existing) {
          const updated = new Transaction(existing);
          updated.label.memo = newMemo;
          newTransactions.set(transaction_id, updated);
        }
        newData.transactions = newTransactions;
        return newData;
      });
    }
  };

  // Manual-row inline editing (#567). Plaid rows keep the read-only
  // `<span>` display below; only `source === 'manual'` unlocks these
  // inputs so we never overwrite a Plaid-synced field. Save-on-blur
  // matches the existing memo pattern — no explicit save button.
  const [nameValue, setNameValue] = useState(name ?? "");
  const [amountValue, setAmountValue] = useState(String(amount ?? 0));
  const [dateValue, setDateValue] = useState((authorized_date || date || "").slice(0, 10));
  useEffect(() => {
    setNameValue(name ?? "");
    setAmountValue(String(amount ?? 0));
    setDateValue((authorized_date || date || "").slice(0, 10));
  }, [transaction_id, name, amount, authorized_date, date]);

  const persistTransactionField = async (patch: Partial<Transaction>) => {
    const r = await call.post("/api/transaction", { transaction_id, ...patch });
    if (r.status !== "success") return false;
    setData((oldData) => {
      const newData = new Data(oldData);
      const dict = new TransactionDictionary(oldData.transactions);
      const existing = dict.get(transaction_id);
      if (existing) {
        const updated = new Transaction(existing);
        Object.assign(updated, patch);
        indexedDb.save(updated).catch(console.error);
        dict.set(transaction_id, updated);
      }
      newData.transactions = dict;
      return newData;
    });
    return true;
  };

  const onBlurName = async () => {
    if (!isManual) return;
    if (nameValue === (name ?? "")) return;
    await persistTransactionField({ name: nameValue });
  };
  const onBlurAmount = async () => {
    if (!isManual) return;
    const parsed = parseFloat(amountValue);
    if (!Number.isFinite(parsed) || parsed === amount) {
      setAmountValue(String(amount ?? 0));
      return;
    }
    await persistTransactionField({ amount: parsed });
  };
  const onBlurDate = async () => {
    if (!isManual) return;
    if (!dateValue || dateValue === (authorized_date || date || "").slice(0, 10)) return;
    await persistTransactionField({ date: dateValue });
  };

  const remainingAmount = transaction.getRemainingAmount(transactionFamilies);

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ transaction_id, account_id }).toString();
    const newSplitTransactionResponse = await call.get<NewSplitTransactionGetResponse>(
      "/api/new-split-transaction" + queryString,
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

    const addResponse = await call.post("/api/split-transaction", newSplitTransaction);

    if (addResponse.status !== "success") {
      console.error("Failed to save split transaction:", addResponse.message);
      return;
    }

    setData((oldData) => {
      const newData = new Data(oldData);
      indexedDb.save(newSplitTransaction).catch(console.error);
      const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
      newSplitTransactions.set(newSplitTransaction.split_transaction_id, newSplitTransaction);
      newData.splitTransactions = newSplitTransactions;
      return newData;
    });
  };

  const splitTransactionInputRows = transactionFamilies
    .get(transaction_id)
    ?.toArray()
    .map((s) => {
      return (
        <Row key={s.id}>
          <SplitTransactionRow splitTransaction={s} />
        </Row>
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

  // Manual "Mark as Transfer" picker — surfaces transactions that COULD be
  // this transaction's transfer partner: opposite sign on the amount, same
  // absolute value, within ±3 days (matches detect-transfers' algorithm).
  // Anything already in a confirmed or suggested pair is filtered out so
  // the user can't double-bind a transaction.
  const [showPartnerPicker, setShowPartnerPicker] = useState(false);
  const [pendingPartnerId, setPendingPartnerId] = useState<string | null>(null);

  const txAmount = transaction.amount;
  const txDateMs = new LocalDate(authorized_date || date).getTime();
  const partnerCandidates = useMemo(() => {
    const candidates: Transaction[] = [];
    data.transactions.forEach((t) => {
      if (t.transaction_id === transaction_id) return;
      // Opposite sign + same absolute amount.
      if (Math.sign(t.amount) === Math.sign(txAmount)) return;
      if (Math.abs(t.amount) !== Math.abs(txAmount)) return;
      // Within ±PARTNER_DATE_WINDOW_DAYS.
      const tDateMs = new LocalDate(t.authorized_date || t.date).getTime();
      if (Math.abs(tDateMs - txDateMs) > PARTNER_DATE_WINDOW_DAYS * ONE_DAY_MS) return;
      // Skip transactions already in any pair (confirmed or suggested).
      if (transfers.byTransactionId.has(t.transaction_id)) return;
      candidates.push(t);
    });
    candidates.sort((a, b) => {
      const aDateMs = new LocalDate(a.authorized_date || a.date).getTime();
      const bDateMs = new LocalDate(b.authorized_date || b.date).getTime();
      return Math.abs(aDateMs - txDateMs) - Math.abs(bDateMs - txDateMs);
    });
    return candidates;
  }, [data.transactions, transaction_id, txAmount, txDateMs, transfers]);

  const onClickPartnerCandidate = async (partnerId: string) => {
    setPendingPartnerId(partnerId);
    try {
      await transferActions.pair(transaction_id, partnerId);
      setShowPartnerPicker(false);
    } finally {
      setPendingPartnerId(null);
    }
  };

  return (
    <Properties className="TransactionProperties">
      <PropertyLabel>Transaction&nbsp;Details</PropertyLabel>
      <Property>
        <Row className="keyValue">
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
              {new LocalDate(authorized_date || date).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Merchant&nbsp;Name</span>
          <span>{merchant_name}</span>
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Name</span>
          {isManual ? (
            <input
              type="text"
              value={nameValue}
              placeholder="Transaction name…"
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={onBlurName}
            />
          ) : (
            <span>{name}</span>
          )}
        </Row>
        <Row className="keyValue">
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
              {isIncome && <>+&nbsp;</>}
              {currencySymbol}&nbsp;
              {numberToCommaString(Math.abs(amount))}
            </span>
          )}
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Location</span>
          <span>{locations.join(", ")}</span>
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Account</span>
          <span>{account?.custom_name || account?.name}</span>
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Institution</span>
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </Row>
        <Row className="keyValue">
          <span className="propertyName">Memo</span>
          <input
            type="text"
            value={memoValue}
            placeholder="Add a note…"
            onChange={onChangeMemo}
            onBlur={onBlurMemo}
          />
        </Row>
      </Property>
      {!splitTransactionInputRows?.length && (
        <>
          <PropertyLabel>Budgets</PropertyLabel>
          <Property>
            <Row className="keyValue">
              <span className="propertyName">Budget</span>
              <div>
                <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                  <option value="">Select Budget</option>
                  {budgetOptions}
                </select>
              </div>
            </Row>
            <Row className="keyValue">
              <span className="propertyName">Section</span>
              <span>{sectionName}</span>
            </Row>
            <Row className="keyValue">
              <span className="propertyName">Category</span>
              <div className={selectedCategoryIdLabel ? "" : "notification"}>
                <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
                  <option value="">Select Category</option>
                  {categoryOptions}
                </select>
              </div>
            </Row>
          </Property>
        </>
      )}
      <PropertyLabel>Split&nbsp;Transactions</PropertyLabel>
      <Property>
        {splitTransactionInputRows}
        {!!splitTransactionInputRows?.length && (
          <Row>
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
          </Row>
        )}
        <Row className="button">
          <button onClick={onClickAdd}>Add&nbsp;New&nbsp;Split</button>
        </Row>
      </Property>
      <PropertyLabel>Transfer</PropertyLabel>
      <Property>
        {!showPartnerPicker && (
          <Row className="button">
            <button
              className="markAsTransferButton"
              onClick={() => setShowPartnerPicker(true)}
            >
              <TransferArrowIcon size={12} />
              &nbsp;Mark&nbsp;as&nbsp;Transfer
            </button>
          </Row>
        )}
        {showPartnerPicker && (
          <>
            <Row className="keyValue">
              <span className="propertyName">Pair&nbsp;with</span>
            </Row>
            {partnerCandidates.length === 0 && (
              <Row className="partnerPickerEmpty">
                <span className="partnerPickerEmptyText">
                  No matching transactions within ±{PARTNER_DATE_WINDOW_DAYS} days
                  (opposite sign, same absolute amount, not already paired).
                </span>
              </Row>
            )}
            {partnerCandidates.map((candidate) => {
              const candidateAccount = accounts.get(candidate.account_id);
              const candidateInstitutionId = candidateAccount?.institution_id;
              const isPending = pendingPartnerId === candidate.transaction_id;
              const disabled = !!pendingPartnerId;
              const onClick = disabled
                ? undefined
                : () => onClickPartnerCandidate(candidate.transaction_id);
              return (
                <Row
                  key={candidate.transaction_id}
                  className={`partnerCandidate${disabled ? " disabled" : ""}`}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled}
                  onClick={onClick}
                  onKeyDown={(e) => {
                    if (!disabled && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onClick?.();
                    }
                  }}
                >
                  <div className="partnerCandidateInfo">
                    <div className="authorized_date bigText">
                      {new LocalDate(
                        candidate.authorized_date || candidate.date,
                      ).toLocaleString("en-US", {
                        month: "numeric",
                        day: "numeric",
                      })}
                    </div>
                    <div className="merchant_name">
                      {candidate.merchant_name && (
                        <div className="bigText">{candidate.merchant_name}</div>
                      )}
                      {candidate.name && (
                        <div className="smallText">{candidate.name}</div>
                      )}
                      <div className="bigText">
                        {candidateAccount?.custom_name || candidateAccount?.name}
                      </div>
                      {candidateInstitutionId && (
                        <div className="smallText">
                          <InstitutionSpan institution_id={candidateInstitutionId} />
                        </div>
                      )}
                    </div>
                    <div className="amount">
                      {currencyCodeToSymbol(candidate.iso_currency_code || "")}&nbsp;
                      {numberToCommaString(Math.abs(candidate.amount))}
                      {isPending && <>&nbsp;…</>}
                    </div>
                  </div>
                </Row>
              );
            })}
            <Row className="button">
              <button
                className="markAsTransferCancel"
                disabled={!!pendingPartnerId}
                onClick={() => setShowPartnerPicker(false)}
              >
                Cancel
              </button>
            </Row>
          </>
        )}
      </Property>
      {isManual && (
        <>
          <br />
          <Property>
            <Row className="button">
              <button
                className="delete colored"
                onClick={async () => {
                  if (!window.confirm("Delete this transaction? This can't be undone.")) return;
                  const r = await call.delete("/api/transaction?" + new URLSearchParams({ transaction_id }).toString());
                  if (r.status !== "success") return;
                  setData((oldData) => {
                    const next = new Data(oldData);
                    const dict = new TransactionDictionary(oldData.transactions);
                    dict.delete(transaction_id);
                    next.transactions = dict;
                    indexedDb.remove(StoreName.transactions, transaction_id).catch(console.error);
                    return next;
                  });
                  router.back();
                }}
              >
                Delete
              </button>
            </Row>
          </Property>
        </>
      )}
    </Properties>
  );
};
