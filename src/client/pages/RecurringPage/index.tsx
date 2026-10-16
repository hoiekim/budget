import { KeyboardEvent, useRef, useState } from "react";
import { LocalDate, RecurringCadence } from "common";
import { PATH, Transaction, useAppContext, useRecurrings } from "client";
import type { Recurring } from "server";
import {
  ChevronDownIcon,
  PageTitle,
  Placeholder,
  TransactionRowInfo,
} from "client/components";
import "./index.css";

const CADENCE_LABELS: Record<RecurringCadence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semiannual",
  annual: "Annual",
};

const formatShortDate = (dateString: string) =>
  new LocalDate(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

/** Median absolute amount of the member transactions. */
const medianAmount = (transactions: Recurring["transactions"]): number => {
  const amounts = transactions
    .map((t) => Math.abs(t.amount))
    .sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  return amounts.length % 2 === 1
    ? amounts[mid]!
    : (amounts[mid - 1]! + amounts[mid]!) / 2;
};

const lastDate = (transactions: Recurring["transactions"]): string => {
  let latest = "";
  for (const t of transactions) {
    const d = (t.authorized_date || t.date).slice(0, 10);
    if (d > latest) latest = d;
  }
  return latest;
};

interface RecurringRowProps {
  recurring: Recurring;
  expanded: boolean;
  onToggle: () => void;
  onOpenTransaction: (transactionId: string) => void;
  getTransaction: (transactionId: string) => Transaction | undefined;
}

/**
 * One recurring, rendered on the shared transaction-row scaffold
 * (`div.TransactionRow` + `TransactionRowInfo` — the same primitives the
 * TransactionsPage list is built from).
 *
 * Suggested recurrings carry named Confirm / Dismiss buttons (this page is
 * the decision surface, so no modal indirection like the transactions
 * list's Transfer chip). Dismissing writes `status='dismissed'`, which the
 * detection engine reads as a permanent per-merchant denylist. Confirmed
 * recurrings expand to their member transactions.
 */
const RecurringRow = ({
  recurring,
  expanded,
  onToggle,
  onOpenTransaction,
  getTransaction,
}: RecurringRowProps) => {
  const { confirm, dismiss } = useRecurrings();
  // In-flight guard (mirrors TransferControls): the ref refuses the
  // second click, because setState lands on the next render and the
  // buttons stay clickable until then.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<boolean>) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  const amount = medianAmount(recurring.transactions);
  const last = lastDate(recurring.transactions);
  const currency =
    recurring.transactions[0]?.iso_currency_code ||
    recurring.transactions[0]?.unofficial_currency_code ||
    "";

  return (
    <div className="TransactionRow">
      <div
        className="recurringSummary"
        onClick={onToggle}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${recurring.merchant_name}, ${CADENCE_LABELS[recurring.cadence]}`}
      >
        <TransactionRowInfo
          date={last}
          amount={recurring.is_income ? amount : -amount}
          isoCurrency={currency}
          amountSign="none"
        >
          <div className="bigText">
            {recurring.merchant_name}
            {recurring.status === "suggested" && (
              <span className="recurringSuggestedBadge">Suggested</span>
            )}
          </div>
          <div className="smallText">
            {CADENCE_LABELS[recurring.cadence]} · {recurring.transactions.length}{" "}
            {recurring.is_income ? "deposits" : "charges"}
            {last && <> · Last {formatShortDate(last)}</>}
          </div>
        </TransactionRowInfo>
        <div className={`recurringChevron${expanded ? " expanded" : ""}`}>
          <ChevronDownIcon size={14} />
        </div>
      </div>
      {recurring.status === "suggested" && (
        <div className="recurringActions">
          <button
            className="recurringConfirm"
            disabled={busy}
            onClick={run(() => confirm(recurring.recurring_id))}
          >
            Confirm
          </button>
          <button
            className="recurringDismiss"
            disabled={busy}
            onClick={run(() => dismiss(recurring.recurring_id))}
          >
            Dismiss
          </button>
        </div>
      )}
      {expanded &&
        recurring.transactions.map((t) => {
          const full = getTransaction(t.transaction_id) || t;
          return (
            <TransactionRowInfo
              key={t.transaction_id}
              date={full.authorized_date || full.date}
              amount={full.amount}
              isoCurrency={
                full.iso_currency_code || full.unofficial_currency_code || ""
              }
              amountSign="none"
              onClickInfo={() => onOpenTransaction(t.transaction_id)}
            >
              <div className="bigText">{full.merchant_name || full.name}</div>
            </TransactionRowInfo>
          );
        })}
    </div>
  );
};

/**
 * Recurrings — server-detected repeating bills and income, following the
 * transfers pattern end-to-end: a detection job suggests merchant groups,
 * the user confirms or dismisses them, and confirmed recurrings auto-attach
 * future matching charges. State lives in `data.recurrings`, synced via
 * `useSync`'s delta pipeline like `data.transfers`.
 *
 * Reached from the Transactions page via the "View recurring" link under
 * the table; grouped under the Transactions nav tab.
 */
export const RecurringPage = () => {
  const { data, router } = useAppContext();
  const { recurrings, transactions } = data;
  const { go, params } = router;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const suggested: Recurring[] = [];
  const confirmed: Recurring[] = [];
  recurrings.forEach((r) => {
    if (r.status === "suggested") suggested.push(r);
    else if (r.status === "confirmed") confirmed.push(r);
  });
  // Suggested first (they need a decision), then confirmed.
  const ordered = [...suggested, ...confirmed];

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openTransaction = (transactionId: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("investment_transaction_id");
    nextParams.set("transaction_id", transactionId);
    go(PATH.TRANSACTION_DETAIL, { params: nextParams });
  };

  return (
    <div className="RecurringPage">
      <PageTitle>
        Recurring{ordered.length > 0 && <> ({ordered.length})</>}
      </PageTitle>
      {ordered.length === 0 ? (
        <Placeholder>
          No recurrings detected yet. Bills and income appear here once a
          merchant has charged or paid you at least 3 times on a regular
          schedule.
        </Placeholder>
      ) : (
        <>
          {ordered.map((recurring) => (
            <RecurringRow
              key={recurring.recurring_id}
              recurring={recurring}
              expanded={expandedIds.has(recurring.recurring_id)}
              onToggle={() => toggle(recurring.recurring_id)}
              onOpenTransaction={openTransaction}
              getTransaction={(id) => transactions.get(id)}
            />
          ))}
        </>
      )}
    </div>
  );
};
