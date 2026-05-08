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

export const HoldingsComposition = ({ account }: Props) => {
  const { account_id, balances } = account;
  const { iso_currency_code } = balances;
  const currencySymbol = currencyCodeToSymbol(iso_currency_code || "");

  const { calculations, viewDate, data } = useAppContext();
  const { holdingsValueData } = calculations;
  const { securitySnapshots } = data;

  const viewEndDate = viewDate.getEndDate();

  const rows = useMemo<HoldingRow[]>(() => {
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

  if (rows.length === 0) return null;

  const totalValue = rows.reduce((s, r) => s + r.value, 0);
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
