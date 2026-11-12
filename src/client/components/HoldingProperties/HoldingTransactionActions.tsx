import { useMemo } from "react";
import { numberToCommaString } from "common";
import {
  useAppContext,
  useHoldingDivergence,
  useTransactionEntry,
  buildPriceAt,
  HoldingSnapshot,
  PropertyLabel,
  Property,
  ButtonRow,
} from "client";

interface HoldingTransactionActionsProps {
  accountId: string;
  snapshots: HoldingSnapshot[];
}

/**
 * The "Add" section of the holding detail page: mint an investment
 * transaction for the holding, plus the one-tap reconcile action when the
 * holding's security has an unreconciled holdings-vs-transactions surplus.
 * Extracted from HoldingProperties so the detail page stays composition —
 * the bucket derivation still lives in the parent and arrives as props.
 */
export const HoldingTransactionActions = ({
  accountId,
  snapshots,
}: HoldingTransactionActionsProps) => {
  const { data, calculations, viewDate } = useAppContext();
  const viewEndDate = viewDate.getEndDate();

  /**
   * `Add Investment Transaction` on the holding: prefill `security_id`,
   * `price` (from the holding's `institution_price`), and
   * `iso_currency_code` from the holding context so the user starts
   * with values they can confirm/correct rather than 0 / null defaults.
   * When the bucket spans multiple securities (rare — merged tickers),
   * use the first snapshot.
   */
  const primaryHolding = snapshots[0]?.holding;
  const primarySecurityId = primaryHolding?.security_id ?? null;
  const primaryPrice = primaryHolding?.institution_price ?? null;
  const primaryCurrency = primaryHolding?.iso_currency_code ?? null;
  const { addInvestmentTransaction } = useTransactionEntry();
  const onClickAddInvestmentTransaction = () => {
    if (!accountId) return;
    return addInvestmentTransaction({
      account_id: accountId,
      security_id: primarySecurityId,
      price: primaryPrice,
      iso_currency_code: primaryCurrency,
    });
  };

  // Divergence action: if this holding's security_id has a
  // holdings-vs-transactions mismatch, offer a one-tap mint prefilled
  // with the missing units so the user can reconcile without hunting
  // for the security or typing the qty. Direction A ("holdings > txn")
  // → a Buy for the missing units. Direction B ("txn > holdings")
  // suggests a Sell — but this branch only exposes the Buy action
  // for now because the "holding page" surface is only reached from
  // holdings the user actually owns.
  const divergence = useHoldingDivergence(
    accountId ? [accountId] : [],
    {
      holdingSnapshots: calculations.holdingSnapshots,
      investmentTransactions: data.investmentTransactions,
      securitySnapshots: data.securitySnapshots,
    },
    viewEndDate.toISOString().slice(0, 10),
  );
  // Second computation at TODAY — the button's presence tracks the security's
  // LATEST unreconciled surplus, not just the current view's window, so the
  // user can reach the reconcile action from any past view. Reason for the
  // mismatch with per-viewDate divergence: divergence at a past view can fire
  // for a DIFFERENT security than the one the user is inspecting (widget
  // footnote aggregates across the account), or the current holding's snapshot
  // history might not extend that far back. Today-anchored divergence gates
  // the button on "does this security still have unreconciled shares" — a
  // property of the data rather than the viewDate.
  const divergenceNow = useHoldingDivergence(
    accountId ? [accountId] : [],
    {
      holdingSnapshots: calculations.holdingSnapshots,
      investmentTransactions: data.investmentTransactions,
      securitySnapshots: data.securitySnapshots,
    },
    undefined,
  );
  const divergentEntry = primarySecurityId
    ? divergenceNow.bySecurity.get(primarySecurityId)
    : undefined;
  // `divergence` (per-viewDate) is retained for a future "you're
  // looking at a divergent past window" indicator; today it's unused
  // beyond parity with HoldingsComposition's dot.
  void divergence;
  const missingUnits =
    divergentEntry && divergentEntry.direction === "holdingExcess" ? divergentEntry.deltaQty : 0;
  // Reconciliation date: the earliest holdings snapshot where the qty
  // FIRST reached the current owned value — i.e. where the surplus
  // "arrived". Backdating there clears the divergence at every window
  // whose end date is at-or-after that point. Naive "earliest snap"
  // dating fails because `txnDerivedQtyBySecurity` anchors from the
  // latest snap ≤ windowStart AND excludes txns dated ≤ windowStart
  // (they'd double-count with the anchor). So a txn dated at the earliest
  // snap falls BEHIND the anchor for every window whose windowStart is
  // later than that — including the current 1Y view. Result: seen stays
  // at the anchor value and divergence still fires. Dating at the
  // qty-jump point puts the txn STRICTLY BETWEEN the "before" and
  // "after" anchor eras, so it's in-walk for every window ending at-or-
  // after the jump.
  const reconcileDate = useMemo(() => {
    if (!primarySecurityId || !accountId) return undefined;
    const snaps: { date: string; qty: number }[] = [];
    calculations.holdingSnapshots.forEach((snap) => {
      if (snap.holding.account_id !== accountId) return;
      if (snap.holding.security_id !== primarySecurityId) return;
      snaps.push({
        date: snap.snapshot.date.slice(0, 10),
        qty: snap.holding.quantity ?? 0,
      });
    });
    if (!snaps.length) return undefined;
    snaps.sort((a, b) => (a.date < b.date ? -1 : 1));
    const currentOwned = snaps[snaps.length - 1].qty;
    // First snapshot where qty >= currentOwned = when the jump completed.
    // Fall back to the earliest snapshot if no snap reaches that (only
    // possible on floating-point rounding across the array).
    const jump = snaps.find((s) => s.qty >= currentOwned - Math.abs(currentOwned) * 1e-6);
    return jump?.date ?? snaps[0].date;
  }, [calculations.holdingSnapshots, accountId, primarySecurityId]);
  const onClickAddDivergentTransaction = () => {
    if (!accountId) return;
    // Price the mint at its own historical date via the shared
    // `buildPriceAt` helper (security_snapshots close series + txn-
    // embedded buy/sell prices merged, latest ≤ query date). Falls
    // back to `primaryPrice` if no history covers the reconcile date.
    const priceAt = buildPriceAt(data.securitySnapshots, data.investmentTransactions);
    const pricedAt =
      primarySecurityId && reconcileDate ? priceAt(primarySecurityId, reconcileDate) : null;
    return addInvestmentTransaction({
      account_id: accountId,
      security_id: primarySecurityId,
      price: pricedAt ?? primaryPrice,
      iso_currency_code: primaryCurrency,
      quantity: missingUnits,
      date: reconcileDate,
    });
  };

  return (
    <>
      <PropertyLabel>Add</PropertyLabel>
      <Property>
        <ButtonRow type="button" onClick={onClickAddInvestmentTransaction}>
          Add&nbsp;Investment&nbsp;Transaction
        </ButtonRow>
        {missingUnits > 0 && (
          <ButtonRow type="button" onClick={onClickAddDivergentTransaction}>
            Add&nbsp;transaction&nbsp;for&nbsp;
            {numberToCommaString(missingUnits, 4)}&nbsp;missing&nbsp;units
          </ButtonRow>
        )}
      </Property>
    </>
  );
};
