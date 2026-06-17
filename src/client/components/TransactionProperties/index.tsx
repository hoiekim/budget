import { ChangeEventHandler, useMemo, useState, useEffect } from "react";
import { currencyCodeToSymbol, LocalDate, numberToCommaString } from "common";
import { NewSplitTransactionGetResponse } from "server";
import {
  Category,
  Data,
  SplitTransaction,
  SplitTransactionDictionary,
  Transaction,
  TransactionDictionary,
  TransactionLabel,
  useAppContext,
  call,
  indexedDb,
} from "client";
import { InstitutionSpan, TransferArrowIcon } from "client/components";
import SplitTransactionRow from "./SplitTransactionRow";
import "./index.css";

// Window for the partner-candidate filter — matches the detect-transfers
// cron's `DATE_WINDOW_DAYS` (see `compute-tools/detect-transfers.ts:8`).
// Keeping these aligned means a user-driven "Mark as Transfer" surfaces
// the same set of candidates the algorithm would have considered.
const PARTNER_DATE_WINDOW_DAYS = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface Props {
  transaction: Transaction;
}

export const TransactionProperties = ({ transaction }: Props) => {
  const { data, setData, calculations, transfers } = useAppContext();
  const { transactionFamilies } = calculations;
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

  useEffect(() => {
    setSelectedBudgetIdLabel(label.budget_id || account?.label.budget_id || "");
    setSelectedCategoryIdLabel(label.category_id || "");
  }, [label, account]);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      if (!e.name.trim()) return;
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
      // Skip transactions already in a pair (confirmed or suggested).
      if (transfers.confirmedTransferByTransactionId.has(t.transaction_id)) return;
      if (transfers.suggestedPairByTransactionId.has(t.transaction_id)) return;
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
      await transfers.pair(transaction_id, partnerId);
      setShowPartnerPicker(false);
    } finally {
      setPendingPartnerId(null);
    }
  };

  return (
    <div className="TransactionProperties Properties">
      <div className="propertyLabel">Transaction&nbsp;Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Date</span>
          <span>
            {new LocalDate(authorized_date || date).toLocaleString("en-US", {
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
      {!splitTransactionInputRows?.length && (
        <>
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
        </>
      )}
      <div className="propertyLabel">Split&nbsp;Transactions</div>
      <div className="property">
        {splitTransactionInputRows}
        {!!splitTransactionInputRows?.length && (
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
      <div className="propertyLabel">Transfer</div>
      <div className="property">
        {!showPartnerPicker && (
          <div className="row button">
            <button
              className="markAsTransferButton"
              onClick={() => setShowPartnerPicker(true)}
            >
              <TransferArrowIcon size={12} />
              &nbsp;Mark&nbsp;as&nbsp;Transfer
            </button>
          </div>
        )}
        {showPartnerPicker && (
          <>
            <div className="row keyValue">
              <span className="propertyName">Pair&nbsp;with</span>
              <button
                className="markAsTransferCancel"
                onClick={() => setShowPartnerPicker(false)}
              >
                Cancel
              </button>
            </div>
            {partnerCandidates.length === 0 && (
              <div className="row keyValue">
                <span>
                  No matching transactions within ±{PARTNER_DATE_WINDOW_DAYS} days
                  (opposite sign, same absolute amount, not already paired).
                </span>
              </div>
            )}
            {partnerCandidates.map((candidate) => {
              const candidateAccount = accounts.get(candidate.account_id);
              const isPending = pendingPartnerId === candidate.transaction_id;
              return (
                <div
                  key={candidate.transaction_id}
                  className="row partnerCandidate"
                >
                  <button
                    className="partnerCandidateButton"
                    disabled={!!pendingPartnerId}
                    onClick={() => onClickPartnerCandidate(candidate.transaction_id)}
                  >
                    <span className="partnerCandidateMeta">
                      <span className="partnerCandidateDate">
                        {new LocalDate(
                          candidate.authorized_date || candidate.date,
                        ).toLocaleString("en-US", {
                          month: "numeric",
                          day: "numeric",
                        })}
                      </span>
                      <span className="partnerCandidateAccount">
                        {candidateAccount?.custom_name || candidateAccount?.name || candidate.account_id}
                      </span>
                      <span className="partnerCandidateName">
                        {candidate.merchant_name || candidate.name}
                      </span>
                    </span>
                    <span className="partnerCandidateAmount">
                      {currencyCodeToSymbol(candidate.iso_currency_code || "")}&nbsp;
                      {numberToCommaString(Math.abs(candidate.amount))}
                      {isPending && <>&nbsp;…</>}
                    </span>
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
