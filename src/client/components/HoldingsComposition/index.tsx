import { useMemo } from "react";
import { currencyCodeToSymbol, numberToCommaString, ViewDate } from "common";
import { Account, useAppContext } from "client";
import "./index.css";

interface Props {
  account: Account;
}

interface HoldingRow {
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
  pct: number;
}

const truncateSecurityId = (id: string) => id.slice(0, 6);

// Synthetic holding_id for the inferred-cash row. Stable per account so
// React's key prop doesn't churn between renders. Not stored anywhere —
// purely a UI construct.
const cashRowId = (accountId: string) => `__inferred_cash__${accountId}`;

export const HoldingsComposition = ({ account }: Props) => {
  const { account_id, balances } = account;
  const { iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { calculations, viewDate, data } = useAppContext();
  const { holdingsValueData } = calculations;
  const { securitySnapshots } = data;

  const viewEndDate = viewDate.getEndDate();

  const realRows = useMemo<HoldingRow[]>(() => {
    const holdingIds = holdingsValueData.getHoldingsForAccount(account_id);
    const totalValue = holdingsValueData.getAccountTotalValue(account_id, viewEndDate);

    return holdingIds
      .map((holdingId): HoldingRow | null => {
        const history = holdingsValueData.getHistory(holdingId);
        const summary = history.get(viewEndDate);
        if (!summary || summary.value === 0) return null;

        const { security_id, quantity, price, value, costBasis, unrealizedGain, costBasisInferred } =
          summary;

        let name: string | null = null;
        let ticker: string | null = null;

        securitySnapshots.forEach((snap) => {
          if (snap.security.security_id === security_id) {
            name = snap.security.name?.trim() || null;
            ticker = snap.security.ticker_symbol ?? null;
          }
        });

        const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;

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
          pct,
        };
      })
      .filter((r): r is HoldingRow => r !== null)
      .sort((a, b) => b.value - a.value);
  }, [account_id, holdingsValueData, viewEndDate, securitySnapshots]);

  // Inferred cash: the broker reports `balances.current` for the whole
  // account (positions + uninvested cash). After summing per-holding values
  // (priced from security snapshots), anything left over is cash the broker
  // didn't surface as a holding row. Clamp at zero — if holdings_total
  // exceeds the broker's total (e.g. we have a fresher market price than
  // Plaid synced), we prefer the holdings total and show no cash row.
  const holdingsTotal = realRows.reduce((s, r) => s + r.value, 0);
  const accountBalance = balances.current ?? 0;
  const inferredCash = Math.max(0, accountBalance - holdingsTotal);

  // Bail when there's nothing to render: no positions AND no leftover cash.
  if (realRows.length === 0 && inferredCash === 0) return null;

  const totalValue = holdingsTotal + inferredCash;

  // Build the combined rows list (real positions + synthetic cash row, if any).
  // Cash gets pct against the combined total, and the per-row pcts of the real
  // rows recompute against the same denominator so the column adds up to 100%.
  const rows: HoldingRow[] = realRows.map((r) => ({
    ...r,
    pct: totalValue > 0 ? (r.value / totalValue) * 100 : 0,
  }));
  if (inferredCash > 0) {
    rows.push({
      holdingId: cashRowId(account_id),
      securityId: "__cash__",
      name: "Cash",
      ticker: "CASH",
      quantity: inferredCash,
      price: 1,
      value: inferredCash,
      // Cash has no cost basis / unrealized G/L by construction.
      costBasis: inferredCash,
      unrealizedGain: 0,
      costBasisInferred: false,
      pct: totalValue > 0 ? (inferredCash / totalValue) * 100 : 0,
    });
  }

  // Cost basis totals only meaningful when every row contributed one. Cash
  // contributes its own value as cost basis (no gain/loss), so it doesn't
  // disqualify the totals row.
  const totalCostBasis = rows.every((r) => r.costBasis !== null)
    ? rows.reduce((s, r) => s + (r.costBasis ?? 0), 0)
    : null;
  const totalGain = totalCostBasis !== null ? totalValue - totalCostBasis : null;

  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isCurrentDate = viewEndDate >= latestViewDate.getEndDate();

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
        {rows.map((row) => {
          const gainClass =
            row.unrealizedGain === null
              ? ""
              : row.unrealizedGain >= 0
                ? "positive"
                : "negative";
          const primaryLabel = row.ticker ?? row.name ?? truncateSecurityId(row.securityId);
          const secondaryLabel = row.ticker ? row.name : null;
          const titleLabel = row.name ?? row.securityId;
          return (
            <div key={row.holdingId} className="holdingsRow">
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
        {!isCurrentDate && (
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
