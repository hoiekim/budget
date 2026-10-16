import { useMemo, useState } from "react";
import { currencyCodeToSymbol, LocalDate, numberToCommaString } from "common";
import {
  CADENCE_LABELS,
  PATH,
  RecurringBill,
  Transaction,
  detectRecurringBills,
  useAppContext,
} from "client";
import { ChevronDownIcon, PageTitle, Placeholder } from "client/components";
import "./index.css";

const formatShortDate = (dateString: string) =>
  new LocalDate(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

const formatAmount = (amount: number, isoCurrencyCode: string | null) => (
  <>
    {currencyCodeToSymbol(isoCurrencyCode || "")}&nbsp;
    {numberToCommaString(amount)}
  </>
);

interface BillRowProps {
  bill: RecurringBill;
  expanded: boolean;
  onToggle: () => void;
  onOpenTransaction: (transactionId: string) => void;
  getTransaction: (transactionId: string) => Transaction | undefined;
}

const BillRow = ({ bill, expanded, onToggle, onOpenTransaction, getTransaction }: BillRowProps) => {
  const rowClasses = ["billRow", expanded ? "expanded" : ""].filter(Boolean).join(" ");
  return (
    <div className={rowClasses}>
      <button className="billSummary" onClick={onToggle} aria-expanded={expanded}>
        <div className="billMain">
          <div className="billMerchant">{bill.merchant}</div>
          <div className="billMeta">
            {CADENCE_LABELS[bill.cadence]} · {bill.occurrences} charges
          </div>
          <div className="billMeta">Last charged {formatShortDate(bill.lastDate)}</div>
        </div>
        <div className="billSide">
          <div className="billAmount">{formatAmount(bill.amount, bill.isoCurrencyCode)}</div>
          <div className="billMeta">Next {formatShortDate(bill.nextExpectedDate)}</div>
        </div>
        <div className="billChevron">
          <ChevronDownIcon size={14} />
        </div>
      </button>
      {expanded && (
        <div className="billOccurrences">
          {bill.transactionIds.map((id) => {
            const t = getTransaction(id);
            if (!t) return null;
            const date = t.authorized_date || t.date;
            return (
              <button
                key={id}
                className="occurrenceRow"
                onClick={() => onOpenTransaction(id)}
              >
                <span className="occurrenceDate">{formatShortDate(date)}</span>
                <span className="occurrenceAmount">
                  {formatAmount(t.amount, t.iso_currency_code || t.unofficial_currency_code)}
                </span>
              </button>
            );
          })}
        </div>
      )}
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
        <div className="billList">
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
        </div>
      )}
    </div>
  );
};
