import { ChangeEventHandler, useMemo, useState, useEffect } from "react";
import {
  currencyCodeToSymbol,
  getNextRecurringDate,
  LocalDate,
  numberToCommaString,
  TRANSFER_DATE_WINDOW_DAYS as PARTNER_DATE_WINDOW_DAYS,
} from "common";
import { NewSplitTransactionGetResponse } from "server";
import {
  Data,
  SplitTransaction,
  SplitTransactionDictionary,
  Transaction,
  TransactionDictionary,
  TransactionLabel,
  useAppContext,
  useBudgetCategorySelect,
  useMutate,
  useRecurrings,
  useTransfers,
  call,
  indexedDb,
} from "client";
import {
  DeleteButton,
  InstitutionSpan,
  KeyValue,
  Properties,
  Property,
  PropertyLabel,
  ButtonRow,
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
  const transactionMutate = useMutate(Transaction);
  const transferActions = useTransfers();
  const recurringActions = useRecurrings();
  const { transactionFamilies } = calculations;
  const { accounts, sections, categories, transfers, recurrings } = data;

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

  // Manual-row inline editing. Plaid rows keep the read-only
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

  // Recurring picker state — mirrors the transfer partner picker above.
  const [showRecurringPicker, setShowRecurringPicker] = useState(false);
  const [recurringName, setRecurringName] = useState("");
  const [pendingRecurringId, setPendingRecurringId] = useState<string | null>(null);
  const existingRecurring = recurrings.byTransactionId.get(transaction_id);
  const isIncomeTx = amount < 0;
  // Confirmed recurrings of the same direction that this transaction could
  // join. Suggested ones are left out: joining one would leave the
  // transaction in a recurring the user never confirmed. Each shows its
  // latest charge as the amount that recurs.
  const recurringCandidates = useMemo(() => {
    const list: { recurring_id: string; merchant_name: string; amount: string }[] = [];
    recurrings.forEach((r) => {
      if (r.is_income !== isIncomeTx) return;
      if (r.status !== "confirmed") return;
      if (r.recurring_id === existingRecurring?.recurring_id) return;
      const latest = r.transactions.reduce<(typeof r.transactions)[number] | undefined>(
        (found, t) =>
          !found || (t.authorized_date || t.date) > (found.authorized_date || found.date)
            ? t
            : found,
        undefined,
      );
      const symbol = currencyCodeToSymbol(latest?.iso_currency_code || "");
      list.push({
        recurring_id: r.recurring_id,
        merchant_name: r.merchant_name,
        amount: latest
          ? `${r.is_income ? "+\u00a0" : ""}${symbol}\u00a0${numberToCommaString(Math.abs(latest.amount))}`
          : "",
      });
    });
    return list.sort((a, b) => a.merchant_name.localeCompare(b.merchant_name));
  }, [recurrings, isIncomeTx, existingRecurring]);

  const onClickCreateRecurring = async () => {
    const displayName = recurringName.trim() || merchant_name || name;
    setPendingRecurringId("new");
    try {
      const id = await recurringActions.create([transaction_id], displayName);
      if (id) setShowRecurringPicker(false);
    } finally {
      setPendingRecurringId(null);
    }
  };

  const onClickRecurringCandidate = async (recurringId: string) => {
    setPendingRecurringId(recurringId);
    try {
      const ok = await recurringActions.addTo(recurringId, [transaction_id]);
      if (ok) setShowRecurringPicker(false);
    } finally {
      setPendingRecurringId(null);
    }
  };

  // Summary of the recurring this transaction belongs to, derived from its
  // member transactions. Dates follow the rest of the UI (authorized date
  // first) so "From" matches what the transactions list shows.
  const recurringSummary = useMemo(() => {
    if (!existingRecurring?.transactions.length) return null;
    const members = existingRecurring.transactions;
    const dates = members
      .map((t) => (t.authorized_date || t.date).slice(0, 10))
      .sort();
    const latest = new LocalDate(dates[dates.length - 1]);
    const total = members.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const currency = members.find((t) => t.iso_currency_code)?.iso_currency_code;
    return {
      first: new LocalDate(dates[0]),
      total,
      currencySymbol: currencyCodeToSymbol(currency || iso_currency_code || ""),
      next: getNextRecurringDate(latest, existingRecurring.cadence),
    };
  }, [existingRecurring, iso_currency_code]);

  // The recurring's default label, edited with the same selects as the
  // transaction's own. The server relabels the recurring's transactions to
  // follow it, apart from ones labeled differently (exceptions).
  const recurringDefaultLabel = useMemo(
    () =>
      new TransactionLabel({
        budget_id: existingRecurring?.label?.budget_id ?? null,
        category_id: existingRecurring?.label?.category_id ?? null,
      }),
    [existingRecurring?.label?.budget_id, existingRecurring?.label?.category_id],
  );
  const recurringSelect = useBudgetCategorySelect(
    recurringDefaultLabel,
    undefined,
    `recurring_${existingRecurring?.recurring_id ?? ""}`,
  );

  const saveRecurringLabel = async (budget_id: string, category_id: string) => {
    if (!existingRecurring) return;
    const previousBudget = recurringSelect.selectedBudgetIdLabel;
    const previousCategory = recurringSelect.selectedCategoryIdLabel;
    recurringSelect.setSelectedBudgetIdLabel(budget_id);
    recurringSelect.setSelectedCategoryIdLabel(category_id);
    const ok = await recurringActions.setLabel(existingRecurring.recurring_id, {
      budget_id: budget_id || null,
      category_id: category_id || null,
    });
    if (!ok) {
      recurringSelect.setSelectedBudgetIdLabel(previousBudget);
      recurringSelect.setSelectedCategoryIdLabel(previousCategory);
    }
  };

  const onChangeRecurringBudget: ChangeEventHandler<HTMLSelectElement> = (e) => {
    if (e.target.value === recurringSelect.selectedBudgetIdLabel) return;
    void saveRecurringLabel(e.target.value, "");
  };

  const onChangeRecurringCategory: ChangeEventHandler<HTMLSelectElement> = (e) => {
    if (e.target.value === recurringSelect.selectedCategoryIdLabel) return;
    void saveRecurringLabel(recurringSelect.selectedBudgetIdLabel, e.target.value);
  };

  // Editable recurring name, saved on blur like the memo above.
  const [recurringNameValue, setRecurringNameValue] = useState(
    existingRecurring?.merchant_name ?? "",
  );
  useEffect(() => {
    setRecurringNameValue(existingRecurring?.merchant_name ?? "");
  }, [existingRecurring?.recurring_id, existingRecurring?.merchant_name]);

  const onBlurRecurringName = async () => {
    if (!existingRecurring) return;
    const trimmed = recurringNameValue.trim();
    if (!trimmed || trimmed === existingRecurring.merchant_name) {
      setRecurringNameValue(existingRecurring.merchant_name);
      return;
    }
    const ok = await recurringActions.rename(existingRecurring.recurring_id, trimmed);
    if (!ok) setRecurringNameValue(existingRecurring.merchant_name);
  };

  // Confirm / dismiss from the detail page. Dismissing a confirmed recurring
  // is how it's cancelled: the server keeps it as `status='dismissed'` so the
  // engine stops re-suggesting it, and "Mark as Recurring" un-dismisses it.
  const [recurringAction, setRecurringAction] = useState<"confirm" | "dismiss" | null>(null);
  const onClickRecurringAction = async (action: "confirm" | "dismiss") => {
    if (!existingRecurring || recurringAction) return;
    setRecurringAction(action);
    try {
      await recurringActions[action](existingRecurring.recurring_id);
    } finally {
      setRecurringAction(null);
    }
  };

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
        <KeyValue name="Date">
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
        </KeyValue>
        <KeyValue name="Merchant&nbsp;Name">
          <span>{merchant_name}</span>
        </KeyValue>
        <KeyValue name="Name">
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
        </KeyValue>
        <KeyValue name="Amount">
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
        </KeyValue>
        <KeyValue name="Location">
          <span>{locations.join(", ")}</span>
        </KeyValue>
        <KeyValue name="Account">
          <span>{account?.custom_name || account?.name}</span>
        </KeyValue>
        <KeyValue name="Institution">
          {account && <InstitutionSpan institution_id={account?.institution_id} />}
        </KeyValue>
        <KeyValue name="Memo">
          <input
            type="text"
            value={memoValue}
            placeholder="Add a note…"
            onChange={onChangeMemo}
            onBlur={onBlurMemo}
          />
        </KeyValue>
      </Property>
      {!splitTransactionInputRows?.length && (
        <>
          <PropertyLabel>Budgets</PropertyLabel>
          <Property>
            <KeyValue name="Budget">
              <div>
                <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                  <option value="">Select Budget</option>
                  {budgetOptions}
                </select>
              </div>
            </KeyValue>
            <KeyValue name="Section">
              <span>{sectionName}</span>
            </KeyValue>
            <KeyValue name="Category">
              <div className={selectedCategoryIdLabel ? "" : "notification"}>
                <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
                  <option value="">Select Category</option>
                  {categoryOptions}
                </select>
              </div>
            </KeyValue>
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
                {isIncome && <>+&nbsp;</>}
                {currencySymbol}&nbsp;
                <input
                  type="text"
                  value={numberToCommaString(Math.abs(remainingAmount))}
                  disabled
                />
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
        <ButtonRow onClick={onClickAdd}>Add&nbsp;New&nbsp;Split</ButtonRow>
      </Property>
      <PropertyLabel>Transfer</PropertyLabel>
      <Property>
        {!showPartnerPicker && (
          <ButtonRow onClick={() => setShowPartnerPicker(true)}>
            <TransferArrowIcon size={12} />
            &nbsp;Mark&nbsp;as&nbsp;Transfer
          </ButtonRow>
        )}
        {showPartnerPicker && (
          <>
            <KeyValue name="Pair&nbsp;with"></KeyValue>
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
            <ButtonRow disabled={!!pendingPartnerId} onClick={() => setShowPartnerPicker(false)}>
              Cancel
            </ButtonRow>
          </>
        )}
      </Property>
      <PropertyLabel>Recurring</PropertyLabel>
      <Property>
        {existingRecurring ? (
          <>
            <KeyValue name="Name">
              <input
                type="text"
                value={recurringNameValue}
                placeholder="Recurring name"
                onChange={(e) => setRecurringNameValue(e.target.value)}
                onBlur={onBlurRecurringName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </KeyValue>
            <KeyValue name="Default&nbsp;Budget">
              <div>
                <select
                  value={recurringSelect.selectedBudgetIdLabel}
                  onChange={onChangeRecurringBudget}
                >
                  <option value="">Select Budget</option>
                  {recurringSelect.budgetOptions}
                </select>
              </div>
            </KeyValue>
            <KeyValue name="Default&nbsp;Category">
              <div>
                <select
                  value={recurringSelect.selectedCategoryIdLabel}
                  onChange={onChangeRecurringCategory}
                >
                  <option value="">Select Category</option>
                  {recurringSelect.categoryOptions}
                </select>
              </div>
            </KeyValue>
            {recurringSummary && (
              <>
                <KeyValue name="From">
                  <span>
                    {recurringSummary.first.toLocaleString("en-US", {
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                </KeyValue>
                <KeyValue name="Total&nbsp;Amount">
                  <span>
                    {existingRecurring.is_income && <>+&nbsp;</>}
                    {recurringSummary.currencySymbol}&nbsp;
                    {numberToCommaString(recurringSummary.total)}
                  </span>
                </KeyValue>
                {recurringSummary.next && (
                  <KeyValue name="Next&nbsp;Due">
                    <span>
                      {recurringSummary.next.toLocaleString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </KeyValue>
                )}
              </>
            )}
            {existingRecurring.status === "suggested" ? (
              <>
                <ButtonRow
                  disabled={!!recurringAction}
                  onClick={() => onClickRecurringAction("confirm")}
                >
                  {recurringAction === "confirm" ? "Confirming…" : <>Confirm&nbsp;Recurring</>}
                </ButtonRow>
                <ButtonRow
                  disabled={!!recurringAction}
                  onClick={() => onClickRecurringAction("dismiss")}
                >
                  {recurringAction === "dismiss" ? "Dismissing…" : <>Dismiss&nbsp;Suggestion</>}
                </ButtonRow>
              </>
            ) : (
              <ButtonRow
                disabled={!!recurringAction}
                onClick={() => onClickRecurringAction("dismiss")}
              >
                {recurringAction === "dismiss" ? "Removing…" : <>Mark&nbsp;as&nbsp;Non-Recurring</>}
              </ButtonRow>
            )}
          </>
        ) : (
          <>
            {!showRecurringPicker && (
              <ButtonRow
                onClick={() => {
                  setRecurringName(merchant_name || name || "");
                  setShowRecurringPicker(true);
                }}
              >
                Mark&nbsp;as&nbsp;Recurring
              </ButtonRow>
            )}
            {showRecurringPicker && (
              <>
                <KeyValue name="Name">
                  <input
                    type="text"
                    value={recurringName}
                    onChange={(e) => setRecurringName(e.target.value)}
                    placeholder={merchant_name || name || "Recurring name"}
                    disabled={!!pendingRecurringId}
                  />
                </KeyValue>
                <ButtonRow
                  disabled={!!pendingRecurringId}
                  onClick={onClickCreateRecurring}
                >
                  {pendingRecurringId === "new" ? "Creating…" : "Create new recurring"}
                </ButtonRow>
                {recurringCandidates.length > 0 && (
                  <>
                    <KeyValue name="Add&nbsp;to&nbsp;existing" />
                    {recurringCandidates.map((candidate) => {
                      const isPending = pendingRecurringId === candidate.recurring_id;
                      const disabled = !!pendingRecurringId;
                      const onClick = disabled
                        ? undefined
                        : () => onClickRecurringCandidate(candidate.recurring_id);
                      return (
                        <Row
                          key={candidate.recurring_id}
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
                          <div className="recurringCandidateInfo">
                            <div className="recurringCandidateName">{candidate.merchant_name}</div>
                            <div className="recurringCandidateAmount">
                              {candidate.amount}
                              {isPending && <>&nbsp;…</>}
                            </div>
                          </div>
                        </Row>
                      );
                    })}
                  </>
                )}
                <ButtonRow
                  disabled={!!pendingRecurringId}
                  onClick={() => setShowRecurringPicker(false)}
                >
                  Cancel
                </ButtonRow>
              </>
            )}
          </>
        )}
      </Property>
      {isManual && (
        <>
          <br />
          <Property>
            <Row className="button">
              <DeleteButton
                confirmMessage="Delete this transaction? This can't be undone."
                onClick={async () => {
                  await transactionMutate.delete(transaction_id);
                  router.back();
                }}
              >
                Delete
              </DeleteButton>
            </Row>
          </Property>
        </>
      )}
    </Properties>
  );
};
