import { useEffect, ChangeEventHandler, MouseEventHandler } from "react";
import { numberToCommaString, currencyCodeToSymbol, LocalDate } from "common";
import {
  useAppContext,
  useBudgetCategorySelect,
  useTransfers,
  call,
  PATH,
  Transaction,
  TransactionLabel,
  Data,
  TransactionDictionary,
  SplitTransaction,
  SplitTransactionDictionary,
  indexedDb,
} from "client";
import { InstitutionSpan, KebabIcon } from "client/components";
import { ApiResponse } from "server";
import TransferControls from "./TransferControls";

interface Props {
  transaction: Transaction | SplitTransaction;
}

const TransactionRow = ({ transaction }: Props) => {
  const { data, calculations, setData, router } = useAppContext();
  const transferActions = useTransfers();
  const { transfers } = data;
  const { transactionFamilies } = calculations;
  const { id, transaction_id, amount, label } = transaction;
  const parentTransaction = data.transactions.get(transaction_id)!;
  const { account_id, authorized_date, date, merchant_name, name, location, iso_currency_code } =
    parentTransaction;
  const amountAfterSplit = amount - transactionFamilies.getChildrenAmountTotal(id);

  const { accounts } = data;
  const { go } = router;

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  const {
    selectedBudgetIdLabel,
    setSelectedBudgetIdLabel,
    selectedCategoryIdLabel,
    setSelectedCategoryIdLabel,
    budgetOptions,
    categoryOptions,
  } = useBudgetCategorySelect(label, account, `transaction_${id}`);
  const categoryConfidence = label.category_confidence ?? null;

  const isSuggested =
    !!selectedCategoryIdLabel &&
    categoryConfidence !== null &&
    categoryConfidence > 0 &&
    categoryConfidence < 1;
  const categoryWrapperClass = !selectedCategoryIdLabel
    ? "notification"
    : isSuggested
      ? "suggested clickable"
      : "";

  useEffect(() => {
    if (label.budget_id) return;
    setSelectedBudgetIdLabel(account?.label.budget_id || "");
  }, [label.budget_id, account?.label.budget_id, setSelectedBudgetIdLabel]);

  const isSplitTransaction = transaction instanceof SplitTransaction;

  // A row whose parent transaction belongs to a still-suggested transfer pair
  // shows Confirm/Reject instead of the budget/category controls (#354). Split
  // rows never carry the affordance — the detection engine pairs whole
  // transactions, and a split inherits its parent's transaction_id.
  const pendingTransferPair = isSplitTransaction
    ? undefined
    : transfers.byTransactionId.get(transaction_id);
  const suggestedPairId =
    pendingTransferPair?.status === "suggested" ? pendingTransferPair.pair_id : undefined;

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value);
    setSelectedCategoryIdLabel("");

    let response: ApiResponse;
    if (isSplitTransaction) {
      response = await call.post("/api/split-transaction", {
        split_transaction_id: id,
        label: { budget_id: value || null, category_id: null, category_confidence: 0 },
      });
    } else {
      response = await call.post("/api/transaction", {
        transaction_id: id,
        label: { budget_id: value || null, category_id: null, category_confidence: 0 },
      });
    }

    if (response.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        if (isSplitTransaction) {
          const newSplitTransaction = new SplitTransaction(transaction);
          newSplitTransaction.label.budget_id = value || null;
          newSplitTransaction.label.category_id = null;
          newSplitTransaction.label.category_confidence = 0;
          indexedDb.save(newSplitTransaction).catch(console.error);
          const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
          newSplitTransactions.set(id, newSplitTransaction);
          newData.splitTransactions = newSplitTransactions;
        } else {
          const newTransaction = new Transaction(parentTransaction);
          newTransaction.label.budget_id = value || null;
          newTransaction.label.category_id = null;
          newTransaction.label.category_confidence = 0;
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
    // Any user-driven category change resolves the suggestion: 1 = accept
    // (picked a value), 0 = reject (cleared to "Select Category"). Per the
    // JSONTransactionLabel docstring, 1.0 = confirmed and 0.0 = rejected.
    const nextConfidence = value ? 1 : 0;
    const labelQuery = new TransactionLabel({
      category_id: value || null,
      category_confidence: nextConfidence,
    });
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
          const newSplitTransaction = new SplitTransaction(transaction);
          if (!newSplitTransaction.label.budget_id) {
            newSplitTransaction.label.budget_id = account?.label.budget_id;
          }
          newSplitTransaction.label.category_id = value || null;
          newSplitTransaction.label.category_confidence = nextConfidence;
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
          newTransaction.label.category_confidence = nextConfidence;
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

  // Accept-in-place: clicking the yellow dot (without changing the select)
  // confirms the suggested category as-is. Per issue #98 §2 "On transaction
  // row label interaction" — the dot itself is the interaction surface.
  const onAcceptSuggestion = async () => {
    if (!isSuggested || !selectedCategoryIdLabel) return;
    let response: ApiResponse;
    if (isSplitTransaction) {
      response = await call.post("/api/split-transaction", {
        split_transaction_id: id,
        label: { category_confidence: 1 },
      });
    } else {
      response = await call.post("/api/transaction", {
        transaction_id: id,
        label: { category_confidence: 1 },
      });
    }
    if (response.status !== "success") return;
    setData((oldData) => {
      const newData = new Data(oldData);
      if (isSplitTransaction) {
        const newSplitTransaction = new SplitTransaction(transaction);
        newSplitTransaction.label.category_confidence = 1;
        indexedDb.save(newSplitTransaction).catch(console.error);
        const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
        newSplitTransactions.set(id, newSplitTransaction);
        newData.splitTransactions = newSplitTransactions;
      } else {
        const newTransaction = new Transaction(parentTransaction);
        newTransaction.label.category_confidence = 1;
        indexedDb.save(newTransaction).catch(console.error);
        const newTransactions = new TransactionDictionary(newData.transactions);
        newTransactions.set(id, newTransaction);
        newData.transactions = newTransactions;
      }
      return newData;
    });
  };

  const onClickCategoryWrapper: MouseEventHandler<HTMLDivElement> = (e) => {
    // Only handle clicks landing directly on the wrapper (the ::after dot)
    // — not clicks bubbled from the inner <select>.
    if (e.target !== e.currentTarget) return;
    if (isSuggested) void onAcceptSuggestion();
  };

  const onClickConfirm: MouseEventHandler<HTMLButtonElement> = (e) => {
    if (isSuggested) void onAcceptSuggestion();
  };

  const onClickKebab = () => {
    const params = new URLSearchParams(router.params);
    // Clear the sibling id so navigating tx → inv-tx → tx doesn't leave a
    // stale investment_transaction_id in the URL that would win the branch
    // in `TransactionDetailPage`.
    params.delete("investment_transaction_id");
    params.set("transaction_id", parentTransaction.transaction_id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  const { city, region, country } = location;
  const locations = [city, region, country].filter((e) => e);

  return (
    <div className="TransactionRow">
      <div className="transactionInfo" onClick={onClickKebab}>
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
        {suggestedPairId ? (
          <>
            <TransferControls
              onConfirm={() => transferActions.confirm(suggestedPairId)}
              onReject={() => transferActions.reject(suggestedPairId)}
            />
            <div />
          </>
        ) : (
          <>
            <div className="labelControls">
              <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
                <option value="">Select Budget</option>
                {budgetOptions}
              </select>
              <div
                className={categoryWrapperClass}
                onClick={onClickCategoryWrapper}
                title={isSuggested ? "Click the yellow dot to accept this suggestion" : undefined}
              >
                <select value={selectedCategoryIdLabel} onChange={onChangeCategorySelect}>
                  <option value="">Select Category</option>
                  {categoryOptions}
                </select>
              </div>
            </div>
            <div className="confirmButtonBox">
              {isSuggested && (
                <button className="confirmButton" onClick={onClickConfirm}>
                  ✓
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TransactionRow;
