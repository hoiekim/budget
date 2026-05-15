import { KeyboardEvent, useMemo } from "react";
import { currencyCodeToSymbol, ItemProvider, numberToCommaString, ViewDate } from "common";
import { Account, PATH, useAppContext } from "client";
import "./index.css";

interface Props {
  account: Account;
}

interface HoldingRow {
  holdingId: string;
  securityId: string;
  /** Snapshot to navigate to on row click. Prefers the snapshot whose date
   *  matches the current `viewDate`; falls back to the latest snapshot for
   *  this (account, security) when no exact-date match exists. Null when no
   *  snapshot has been recorded yet (shouldn't happen if the row rendered). */
  clickTargetSnapshotId: string | null;
  name: string | null;
  ticker: string | null;
  quantity: number;
  price: number;
  value: number;
  costBasis: number | null;
  unrealizedGain: number | null;
  costBasisInferred: boolean;
  isCash: boolean;
  pct: number;
}

const truncateSecurityId = (id: string) => id.slice(0, 6);

export const HoldingsComposition = ({ account }: Props) => {
  const { account_id, balances, item_id } = account;
  const { iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { calculations, router, viewDate, data } = useAppContext();
  const { holdingsValueData, balanceData } = calculations;
  const { holdingSnapshots, items, securitySnapshots } = data;

  // Editability mirrors the AccountProperties balance input (Hoie 2026-05-15):
  // manual accounts are always editable; synced accounts are only editable
  // at past viewDates. The current viewDate of a synced account is locked
  // because that state is broker-derived and would diverge from the next
  // sync. "+ Add Holding" stays manual-only for the same reason.
  const isManualAccount = items.get(item_id)?.provider === ItemProvider.MANUAL;

  const viewEndDate = viewDate.getEndDate();
  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isCurrentViewDate = viewEndDate >= latestViewDate.getEndDate();
  const isClickableScope = isManualAccount || !isCurrentViewDate;

  // Two lookups per (account, security):
  //   • latest snapshot — fallback target when no per-viewDate snapshot exists.
  //   • viewDate-day snapshot — preferred target so the click edits the
  //     snapshot the user is *looking at*, matching the account-balance
  //     input which writes to the viewDate's account snapshot.
  const viewDayString = viewEndDate.toISOString().slice(0, 10);
  const snapshotIdLookup = useMemo(() => {
    const latest = new Map<string, { id: string; date: string }>();
    const byDay = new Map<string, string>();
    holdingSnapshots.forEach((snap) => {
      const { account_id: a, security_id: s } = snap.holding;
      if (a !== account_id) return;
      const latestKey = `${a}_${s}`;
      const existing = latest.get(latestKey);
      if (!existing || snap.snapshot.date > existing.date) {
        latest.set(latestKey, { id: snap.snapshot.snapshot_id, date: snap.snapshot.date });
      }
      const day = snap.snapshot.date.slice(0, 10);
      byDay.set(`${a}_${s}_${day}`, snap.snapshot.snapshot_id);
    });
    return { latest, byDay };
  }, [account_id, holdingSnapshots]);

  const rows = useMemo<HoldingRow[]>(() => {
    const holdingIds = holdingsValueData.getHoldingsForAccount(account_id);
    const totalValue = holdingsValueData.getAccountTotalValue(account_id, viewEndDate);

    return holdingIds
      .map((holdingId): HoldingRow | null => {
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

        const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
        const sameDay = snapshotIdLookup.byDay.get(
          `${account_id}_${security_id}_${viewDayString}`,
        );
        const latest = snapshotIdLookup.latest.get(`${account_id}_${security_id}`)?.id;
        const clickTargetSnapshotId = sameDay ?? latest ?? null;

        return {
          holdingId,
          securityId: security_id,
          clickTargetSnapshotId,
          name,
          ticker,
          quantity,
          price,
          value,
          costBasis,
          unrealizedGain,
          costBasisInferred,
          isCash,
          pct,
        };
      })
      .filter((r): r is HoldingRow => r !== null)
      .sort((a, b) => b.value - a.value);
  }, [
    account_id,
    holdingsValueData,
    viewEndDate,
    securitySnapshots,
    snapshotIdLookup,
    viewDayString,
  ]);

  const goToHoldingDetail = (snapshotId?: string) => {
    const params = new URLSearchParams();
    params.set("account_id", account_id);
    if (snapshotId) params.set("snapshot_id", snapshotId);
    router.go(PATH.HOLDING_DETAIL, { params });
  };

  // Account snapshot wins for the total (Hoie 2026-05-14: "for account
  // histogram and account total amount, priority is account snapshot if
  // exists. Secondary is holdings total from holdings snapshot. If account
  // snapshot exists and doesn't match with holdings snapshot, display the
  // diff as 'Unknown' in holdings summary table.").
  //
  // The Unknown row is the UI safeguard for reconciliation gaps; the data
  // fix is PR #353's auto-inferred USD cash holding on the server side. On
  // a freshly-synced account #353 closes the gap and Unknown stays at $0
  // (no row); on transient state (just after deploy / before next sync)
  // the Unknown row carries the residual, positive OR negative, so the
  // table's Total still equals the per-view-date account balance either way.
  const holdingsTotal = rows.reduce((s, r) => s + r.value, 0);
  // Per-view-date balance comes from balanceData (the 3-tier-fallback
  // model: account snapshot > holding snapshot > transactions). Falls
  // back to the account's latest `balances.current` only when no data
  // exists for this date at all — which is rare for sync'd accounts.
  const balanceAtView = balanceData.get(account_id, viewEndDate);
  const accountBalance =
    balanceAtView !== undefined ? balanceAtView : (balances.current ?? null);
  const unknownDiff = accountBalance !== null ? accountBalance - holdingsTotal : 0;
  const showUnknownRow = accountBalance !== null && Math.abs(unknownDiff) >= 0.01;

  // For manual accounts we want the section visible even with no rows yet
  // and no balance discrepancy — it hosts the "Add Holding" button.
  if (rows.length === 0 && !showUnknownRow && !isManualAccount) return null;

  // Total = account balance when we have one (preserves Total = balance);
  // otherwise fall back to the holdings sum.
  const totalValue = accountBalance ?? holdingsTotal;

  // Cost basis totals only valid when EVERY non-Unknown row has a cost
  // basis. The Unknown row has unknown cost by construction, so it
  // disqualifies the total gain.
  const allRowsHaveCostBasis = rows.every((r) => r.costBasis !== null);
  const totalCostBasis =
    allRowsHaveCostBasis && !showUnknownRow
      ? rows.reduce((s, r) => s + (r.costBasis ?? 0), 0)
      : null;
  const totalGain = totalCostBasis !== null ? totalValue - totalCostBasis : null;

  // Per-row pct recomputes against the new totalValue so the column
  // (including the Unknown row, if present) still adds to ~100%.
  const adjustedRows = rows.map((r) => ({
    ...r,
    pct: totalValue > 0 ? (r.value / totalValue) * 100 : 0,
  }));
  const unknownPct = showUnknownRow && totalValue > 0 ? (unknownDiff / totalValue) * 100 : 0;

  return (
    <>
      <div className="propertyLabel">Holdings&nbsp;Composition</div>
      <div className="property holdingsTable">
        <div className="holdingsHeader">
          <span className="col-name">Security</span>
          <span className="col-value">Value</span>
          <span className="col-gain">Unrealized G/L</span>
          <span className="col-pct">%</span>
        </div>
        {rows.length === 0 && isManualAccount && (
          <div className="holdingsRow">
            <span className="col-name disabled">No holdings recorded</span>
          </div>
        )}
        {adjustedRows.map((row) => {
          const gainClass =
            row.unrealizedGain === null
              ? ""
              : row.unrealizedGain >= 0
                ? "positive"
                : "negative";
          // Cash holdings get a uniform "Cash" label regardless of how the
          // broker named the underlying sweep ("QACDS", "Chase Deposit
          // Sweep", a truncated security_id, etc.). Hoie 2026-05-14: "When
          // the holding is cash, display 'Cash' instead of the security id."
          const primaryLabel = row.isCash
            ? "Cash"
            : (row.ticker ?? row.name ?? truncateSecurityId(row.securityId));
          const secondaryLabel = row.isCash ? null : row.ticker ? row.name : null;
          const titleLabel = row.isCash ? "Cash" : (row.name ?? row.securityId);
          // Editability mirrors the balance input (Hoie 2026-05-15):
          //   • manual + any viewDate           → editable, row clickable.
          //   • synced + past viewDate          → editable, row clickable.
          //   • synced + current viewDate       → NOT editable, row inert.
          // The click resolves to the snapshot for *this* viewDate when one
          // exists, otherwise the latest snapshot (consistent target so the
          // existing deterministic-snapshot-id POST flow updates both that
          // snapshot and, for manual+current, the live holding row).
          const clickable = isClickableScope && row.clickTargetSnapshotId !== null;
          const onClickRow = clickable
            ? () => goToHoldingDetail(row.clickTargetSnapshotId!)
            : undefined;
          const onKeyDownRow = clickable
            ? (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  goToHoldingDetail(row.clickTargetSnapshotId!);
                }
              }
            : undefined;
          return (
            <div
              key={row.holdingId}
              className={`holdingsRow${clickable ? " clickable" : ""}`}
              onClick={onClickRow}
              onKeyDown={onKeyDownRow}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
            >
              <span className="col-name">
                <span className="security-name" title={titleLabel}>
                  {primaryLabel}
                </span>
                {secondaryLabel && (
                  <span className="security-fullname" title={titleLabel}>
                    {secondaryLabel}
                  </span>
                )}
              </span>
              <span className="col-value">
                {currencySymbol}&nbsp;{numberToCommaString(row.value, 0)}
              </span>
              <span className={`col-gain ${gainClass}`}>
                {row.unrealizedGain !== null ? (
                  <>
                    {row.unrealizedGain >= 0 ? "+" : ""}
                    {currencySymbol}&nbsp;{numberToCommaString(row.unrealizedGain, 0)}
                    {row.costBasisInferred && <span className="inferred-flag" title="Cost basis inferred from transactions">*</span>}
                  </>
                ) : (
                  <span className="no-data">—</span>
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
        {(rows.length > 0 || showUnknownRow) && (
          <div className="holdingsRow total">
            <span className="col-name">Total</span>
            <span className="col-value">
              {currencySymbol}&nbsp;{numberToCommaString(totalValue, 0)}
            </span>
            <span className={`col-gain ${totalGain === null ? "" : totalGain >= 0 ? "positive" : "negative"}`}>
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
          <div className="holdingsFootnote">
            Showing {viewDate.toString()} data
          </div>
        )}
        {rows.some((r) => r.costBasisInferred) && (
          <div className="holdingsFootnote">* Cost basis inferred from transaction history</div>
        )}
      </div>
    </>
  );
};
