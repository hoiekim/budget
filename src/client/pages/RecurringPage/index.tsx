import { KeyboardEvent, useMemo, useState } from "react";
import { LocalDate } from "common";
import {
  CADENCE_LABELS,
  PATH,
  RecurringBill,
  Transaction,
  detectRecurringBills,
  useAppContext,
} from "client";
import {
  ChevronDownIcon,
  PageTitle,
  Placeholder,
  TransactionRowInfo,
} from "client/components";
import "./index.css";

const formatShortDate = (dateString: string) =>
  new LocalDate(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

interface BillRowProps {
  bill: RecurringBill;
  expanded: boolean;
  onToggle: () => void;
  onOpenTransaction: (transactionId: string) => void;
  getTransaction: (transactionId: string) => Transaction | undefined;
}

/**
 * One detected bill, rendered on the shared transaction-row scaffold
 * (`div.TransactionRow` + `TransactionRowInfo` — the same primitives the
 * TransactionsPage list is built from) so it reads as part of the
 * transactions family rather than a one-off card layout. The summary line
 * interposes a `.billSummary` wrapper for the expand chevron; the page CSS
 * re-applies the scaffold geometry to that nesting.
 */
const BillRow = ({ bill, expanded, onToggle, onOpenTransaction, getTransaction }: BillRowProps) => {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div className="TransactionRow">
      <div
        className="billSummary"
        onClick={onToggle}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${bill.merchant}, ${CADENCE_LABELS[bill.cadence]}`}
      >
        <TransactionRowInfo
          date={bill.nextExpectedDate}
          amount={bill.amount}
          isoCurrency={bill.isoCurrencyCode || ""}
          amountSign="none"
        >
          <div className="bigText">{bill.merchant}</div>
          <div className="smallText">
            {CADENCE_LABELS[bill.cadence]} · {bill.occurrences} charges · Last{" "}
            {formatShortDate(bill.lastDate)}
          </div>
        </TransactionRowInfo>
        <div className={`billChevron${expanded ? " expanded" : ""}`}>
          <ChevronDownIcon size={14} />
        </div>
      </div>
      {expanded &&
        bill.transactionIds.map((id) => {
          const t = getTransaction(id);
          if (!t) return null;
          return (
            <TransactionRowInfo
              key={id}
              date={t.authorized_date || t.date}
              amount={t.amount}
              isoCurrency={t.iso_currency_code || t.unofficial_currency_code || ""}
              amountSign="none"
              onClickInfo={() => onOpenTransaction(id)}
            >
              <div className="bigText">{t.merchant_name || t.name}</div>
            </TransactionRowInfo>
          );
        })}
    </div>
  );
};

/**
 * Recurring bill detection — a client-only view. The bill list is a pure
 * derivation (`detectRecurringBills`, in `calculation/`) over the synced
 * transaction dictionary: `useSync`'s delta-sync → IndexedDB → context
 * pipeline owns fetching and caching, and this page simply recomputes the
 * memoized derivation whenever the underlying dictionaries change. No new
 * fetch, no new store, no server work.
 *
 * Reached from the Transactions page via the "View recurring bills" link
 * under the table; grouped under the Transactions nav tab.
 */
export const RecurringPage = () => {
  const { data, router } = useAppContext();
  const { transactions, transfers, accounts } = data;
  const { go, params } = router;
  const [expandedMerchants, setExpandedMerchants] = useState<Set<string>>(new Set());

  const bills = useMemo(() => {
    const candidates: Transaction[] = [];
    transactions.forEach((t) => {
      // Bills are settled outflows: skip pending rows, zero-amount
      // corrections, and inflows, mirroring the TransactionsPage filter.
      if (t.pending || !(t.amount > 0)) return;
      if (accounts.get(t.account_id)?.hide) return;
      // Confirmed transfer halves are internal movement, not bills — the
      // same exclusion the budget calc applies via `byTransactionId`.
      if (transfers.byTransactionId.hasConfirmed(t.transaction_id)) return;
      candidates.push(t);
    });
    return detectRecurringBills(candidates);
  }, [transactions, transfers, accounts]);

  const toggle = (merchant: string) => {
    setExpandedMerchants((prev) => {
      const next = new Set(prev);
      if (next.has(merchant)) next.delete(merchant);
      else next.add(merchant);
      return next;
    });
  };

  const openTransaction = (transactionId: string) => {
    const nextParams = new URLSearchParams(params);
    // Clear the sibling id so a stale investment_transaction_id in the URL
    // doesn't win the branch in `TransactionDetailPage`.
    nextParams.delete("investment_transaction_id");
    nextParams.set("transaction_id", transactionId);
    go(PATH.TRANSACTION_DETAIL, { params: nextParams });
  };

  return (
    <div className="RecurringPage">
      <PageTitle>
        Recurring Bills{bills.length > 0 && <> ({bills.length})</>}
      </PageTitle>
      {bills.length === 0 ? (
        <Placeholder>
          No recurring bills detected yet. Bills appear here once a merchant has
          charged you at least 3 times on a regular schedule.
        </Placeholder>
      ) : (
        <>
          {bills.map((bill) => (
            <BillRow
              key={`${bill.merchant}-${bill.cadence}`}
              bill={bill}
              expanded={expandedMerchants.has(bill.merchant)}
              onToggle={() => toggle(bill.merchant)}
              onOpenTransaction={openTransaction}
              getTransaction={(id) => transactions.get(id)}
            />
          ))}
        </>
      )}
    </div>
  );
};
