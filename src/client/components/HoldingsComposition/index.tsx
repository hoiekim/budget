import { KeyboardEvent, useMemo } from "react";
import { currencyCodeToSymbol, ItemProvider, numberToCommaString, ViewDate } from "common";
import { Account, PATH, useAppContext } from "client";
import "./index.css";

interface Props {
  account: Account;
}

/** Pseudo-ticker for cash holdings. Aggregation key when `isCash` is true,
 *  regardless of whether the underlying snapshot has a real `ticker_symbol`.
 *  Reserved — a real security with `ticker_symbol === "__CASH__"` (which we
 *  treat as unrealistic) would still bucket here. */
export const CASH_TICKER = "__CASH__";

interface PerSecurityRow {
  holdingId: string;
  securityId: string;
  name: string | null;
  ticker: string | null;
  quantity: number;
  price: number;
  value: number;
  costBasis: number | null;
  unrealizedGain: number | null;
  costBasisInferred: boolean;
  isCash: boolean;
}

interface TickerRow {
  /** Aggregation key: real `ticker_symbol` when present (case-folded upper),
   *  otherwise `CASH_TICKER` for `isCash` rows, otherwise the truncated
   *  security_id. URL param for the detail page click target. */
  bucketKey: string;
  /** Display label — "Cash" for `__CASH__`, the ticker itself otherwise. */
  primaryLabel: string;
  /** Secondary line — security name when distinct from the ticker. */
  secondaryLabel: string | null;
  /** Title attribute / accessible name. */
  titleLabel: string;
  quantity: number;
  value: number;
  costBasis: number | null;
  unrealizedGain: number | null;
  costBasisInferred: boolean;
  isCash: boolean;
  pct: number;
  /** Whether the row routes to the detail page. False only for placeholder
   *  buckets that have no underlying snapshots (shouldn't happen given the
   *  filter at construction). */
  clickable: boolean;
}

const truncateSecurityId = (id: string) => id.slice(0, 6);

export const HoldingsComposition = ({ account }: Props) => {
  const { account_id, balances, item_id } = account;
  const { iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { calculations, router, viewDate, data } = useAppContext();
  const { holdingsValueData, balanceData } = calculations;
  const { items, securitySnapshots } = data;

  // Every row is clickable and drills into HOLDING_DETAIL. Edit gating
  // lives on the detail page — synced + current viewDate renders read-only
  // there. "+ Add Holding" stays manual-only because synced brokers
  // re-derive their own holding set on every sync.
  const isManualAccount = items.get(item_id)?.provider === ItemProvider.MANUAL;

  const viewEndDate = viewDate.getEndDate();
  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isCurrentViewDate = viewEndDate >= latestViewDate.getEndDate();

  // First pass: one row per (account, security) at the current viewDate —
  // the calculation hook's per-holding summary. Same shape as before; the
  // aggregation step below collapses these into one row per ticker bucket.
  const perSecurityRows = useMemo<PerSecurityRow[]>(() => {
    const holdingIds = holdingsValueData.getHoldingsForAccount(account_id);

    return holdingIds
      .map((holdingId): PerSecurityRow | null => {
        const history = holdingsValueData.getHistory(holdingId);
        const summary = history.get(viewEndDate);
        if (!summary || summary.value === 0) return null;

        const {
          security_id,
          quantity,
          price,
          value,
          costBasis,
          unrealizedGain,
          costBasisInferred,
          isCash,
        } = summary;

        let name: string | null = null;
        let ticker: string | null = null;

        securitySnapshots.forEach((snap) => {
          if (snap.security.security_id === security_id) {
            name = snap.security.name?.trim() || null;
            ticker = snap.security.ticker_symbol ?? null;
          }
        });

        return {
          holdingId,
          securityId: security_id,
          name,
          ticker,
          quantity,
          price,
          value,
          costBasis,
          unrealizedGain,
          costBasisInferred,
          isCash,
        };
      })
      .filter((r): r is PerSecurityRow => r !== null);
  }, [account_id, holdingsValueData, viewEndDate, securitySnapshots]);

  // Second pass: bucket per-security rows by ticker. Cash → `__CASH__`
  // (regardless of any ticker on the underlying security). Real ticker
  // wins for non-cash. No ticker AND not cash → truncated security_id
  // (rare; e.g. a Plaid security that never resolved). Sum quantity / value
  // / cost basis per bucket; cost basis is null if ANY contributing row
  // lacks it. Unrealized G/L sums when present, else null.
  const tickerRows = useMemo<TickerRow[]>(() => {
    interface Acc {
      quantity: number;
      value: number;
      costBasis: number | null; // null if any contributor is null
      unrealizedGain: number | null; // null if any contributor is null
      costBasisInferred: boolean; // OR'd across contributors
      isCash: boolean;
      // Display fields — keep the first non-null we see.
      name: string | null;
      ticker: string | null;
      securityId: string;
    }
    const buckets = new Map<string, Acc>();

    perSecurityRows.forEach((row) => {
      // Cash always wins the bucket; the `__CASH__` pseudo is reserved.
      // For a (very unlikely) real security whose `ticker_symbol === "__CASH__"`,
      // the non-cash path falls back to the FULL security_id (not truncated
      // — two distinct security_ids whose first 6 chars happen to match
      // would otherwise silently merge into one bucket).
      const tickerUpper = row.ticker?.toUpperCase() ?? null;
      const bucketKey = row.isCash
        ? CASH_TICKER
        : tickerUpper && tickerUpper !== CASH_TICKER
          ? tickerUpper
          : row.securityId;
      const existing = buckets.get(bucketKey);
      if (!existing) {
        buckets.set(bucketKey, {
          quantity: row.quantity,
          value: row.value,
          costBasis: row.costBasis,
          unrealizedGain: row.unrealizedGain,
          costBasisInferred: row.costBasisInferred,
          isCash: row.isCash,
          name: row.name,
          ticker: row.ticker,
          securityId: row.securityId,
        });
      } else {
        existing.quantity += row.quantity;
        existing.value += row.value;
        existing.costBasis =
          existing.costBasis !== null && row.costBasis !== null
            ? existing.costBasis + row.costBasis
            : null;
        existing.unrealizedGain =
          existing.unrealizedGain !== null && row.unrealizedGain !== null
            ? existing.unrealizedGain + row.unrealizedGain
            : null;
        existing.costBasisInferred = existing.costBasisInferred || row.costBasisInferred;
        if (!existing.name && row.name) existing.name = row.name;
        if (!existing.ticker && row.ticker) existing.ticker = row.ticker;
      }
    });

    return Array.from(buckets.entries()).map(([bucketKey, b]) => {
      const primaryLabel = b.isCash
        ? "Cash"
        : (b.ticker ?? b.name ?? truncateSecurityId(b.securityId));
      const secondaryLabel = b.isCash ? null : b.ticker ? b.name : null;
      const titleLabel = b.isCash ? "Cash" : (b.name ?? b.securityId);
      return {
        bucketKey,
        primaryLabel,
        secondaryLabel,
        titleLabel,
        quantity: b.quantity,
        value: b.value,
        costBasis: b.costBasis,
        unrealizedGain: b.unrealizedGain,
        costBasisInferred: b.costBasisInferred,
        isCash: b.isCash,
        pct: 0,
        clickable: true,
      };
    });
  }, [perSecurityRows]);

  const goToHoldingDetail = (bucketKey?: string) => {
    const params = new URLSearchParams();
    params.set("account_id", account_id);
    if (bucketKey) params.set("ticker", bucketKey);
    router.go(PATH.HOLDING_DETAIL, { params });
  };

  // Priority for the account-level total: account snapshot when it exists,
  // otherwise the holdings total derived from holding snapshots. When both
  // exist and disagree, the diff renders as an "Unknown" row in the
  // holdings summary table.
  //
  // The Unknown row is the UI safeguard for reconciliation gaps; the data
  // fix is PR #353's auto-inferred USD cash holding on the server side. On
  // a freshly-synced account #353 closes the gap and Unknown stays at $0
  // (no row); on transient state (just after deploy / before next sync)
  // the Unknown row carries the residual, positive OR negative, so the
  // table's Total still equals the per-view-date account balance either way.
  const holdingsTotal = tickerRows.reduce((s, r) => s + r.value, 0);
  // Per-view-date balance comes from balanceData (the 3-tier-fallback
  // model: account snapshot > holding snapshot > transactions). Falls
  // back to the account's latest `balances.current` only when no data
  // exists for this date at all — which is rare for sync'd accounts.
  const balanceAtView = balanceData.get(account_id, viewEndDate);
  const accountBalance = balanceAtView !== undefined ? balanceAtView : (balances.current ?? null);
  const unknownDiff = accountBalance !== null ? accountBalance - holdingsTotal : 0;
  const showUnknownRow = accountBalance !== null && Math.abs(unknownDiff) >= 0.01;

  // For manual accounts we want the section visible even with no rows yet
  // and no balance discrepancy — it hosts the "Add Holding" button.
  if (tickerRows.length === 0 && !showUnknownRow && !isManualAccount) return null;

  // Total = account balance when we have one (preserves Total = balance);
  // otherwise fall back to the holdings sum.
  const totalValue = accountBalance ?? holdingsTotal;

  // Cost basis totals only valid when EVERY non-Unknown row has a cost
  // basis. The Unknown row has unknown cost by construction, so it
  // disqualifies the total gain. Cash rows have `costBasis = null` by
  // construction, so any account with cash short-circuits this clause.
  const allRowsHaveCostBasis = tickerRows.every((r) => r.costBasis !== null);
  const totalCostBasis =
    allRowsHaveCostBasis && !showUnknownRow
      ? tickerRows.reduce((s, r) => s + (r.costBasis ?? 0), 0)
      : null;
  const totalGain = totalCostBasis !== null ? totalValue - totalCostBasis : null;

  // Per-row pct recomputes against the new totalValue so the column
  // (including the Unknown row, if present) still adds to ~100%.
  const displayRows = tickerRows
    .map((r) => ({ ...r, pct: totalValue > 0 ? (r.value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
  const unknownPct = showUnknownRow && totalValue > 0 ? (unknownDiff / totalValue) * 100 : 0;

  return (
    <>
      <div className="propertyLabel">Holdings&nbsp;Composition</div>
      <div className="property holdingsTable">
        <div className="holdingsHeader">
          <span className="col-name">Security</span>
          <span className="col-value">Value</span>
          <span className="col-gain">Growth</span>
          <span className="col-pct">%</span>
        </div>
        {tickerRows.length === 0 && isManualAccount && (
          <div className="holdingsRow">
            <span className="col-name disabled">No holdings recorded</span>
          </div>
        )}
        {displayRows.map((row) => {
          const gainClass =
            row.isCash || row.unrealizedGain === null
              ? ""
              : row.unrealizedGain >= 0
                ? "positive"
                : "negative";
          const onClickRow = row.clickable ? () => goToHoldingDetail(row.bucketKey) : undefined;
          const onKeyDownRow = row.clickable
            ? (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  goToHoldingDetail(row.bucketKey);
                }
              }
            : undefined;
          return (
            <div
              key={row.bucketKey}
              className={`holdingsRow${row.clickable ? " clickable" : ""}`}
              onClick={onClickRow}
              onKeyDown={onKeyDownRow}
              role={row.clickable ? "button" : undefined}
              tabIndex={row.clickable ? 0 : undefined}
            >
              <span className="col-name">
                <span className="security-name" title={row.titleLabel}>
                  {row.primaryLabel}
                </span>
                {row.secondaryLabel && (
                  <span className="security-fullname" title={row.titleLabel}>
                    {row.secondaryLabel}
                  </span>
                )}
              </span>
              <span className="col-value">
                {currencySymbol}&nbsp;{numberToCommaString(row.value, 0)}
              </span>
              <span className={`col-gain ${gainClass}`}>
                {row.isCash || row.unrealizedGain === null ? (
                  <span className="no-data">—</span>
                ) : (
                  <>
                    {row.unrealizedGain >= 0 ? "+" : ""}
                    {currencySymbol}&nbsp;{numberToCommaString(row.unrealizedGain, 0)}
                    {row.costBasisInferred && (
                      <span className="inferred-flag" title="Cost basis inferred from transactions">
                        *
                      </span>
                    )}
                  </>
                )}
              </span>
              <span className="col-pct">{row.pct.toFixed(1)}%</span>
            </div>
          );
        })}
        {showUnknownRow && (
          <div className="holdingsRow unknown">
            <span className="col-name">
              <span
                className="security-name"
                title="Account balance does not reconcile against the sum of holdings for this view date. The gap is unaccounted for in the holdings table."
              >
                Unknown
              </span>
            </span>
            <span className="col-value">
              {unknownDiff < 0 ? "−" : ""}
              {currencySymbol}&nbsp;{numberToCommaString(Math.abs(unknownDiff), 0)}
            </span>
            <span className="col-gain">
              <span className="no-data">—</span>
            </span>
            <span className="col-pct">{unknownPct.toFixed(1)}%</span>
          </div>
        )}
        {(tickerRows.length > 0 || showUnknownRow) && (
          <div className="holdingsRow total">
            <span className="col-name">Total</span>
            <span className="col-value">
              {currencySymbol}&nbsp;{numberToCommaString(totalValue, 0)}
            </span>
            <span
              className={`col-gain ${totalGain === null ? "" : totalGain >= 0 ? "positive" : "negative"}`}
            >
              {totalGain !== null ? (
                <>
                  {totalGain >= 0 ? "+" : ""}
                  {currencySymbol}&nbsp;{numberToCommaString(totalGain, 0)}
                </>
              ) : (
                <span className="no-data">—</span>
              )}
            </span>
            <span className="col-pct">100%</span>
          </div>
        )}
        {isManualAccount && (
          <div className="holdingsRow holdingsAddRow">
            <button type="button" className="holdingsAddButton" onClick={() => goToHoldingDetail()}>
              + Add Holding
            </button>
          </div>
        )}
        {!isCurrentViewDate && (
          <div className="holdingsFootnote">Showing {viewDate.toString()} data</div>
        )}
        {tickerRows.some((r) => r.costBasisInferred) && (
          <div className="holdingsFootnote">* Cost basis inferred from transaction history</div>
        )}
      </div>
    </>
  );
};
