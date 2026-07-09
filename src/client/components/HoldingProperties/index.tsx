import {
  ChangeEventHandler,
  Fragment,
  FormEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ItemProvider, numberToCommaString, ViewDate, currencyCodeToSymbol } from "common";
import {
  call,
  PATH,
  useAppContext,
  useHoldingDivergence,
  useTransactionEntry,
  buildPriceAt,
  Data,
  Snapshot,
  Holding,
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  Properties,
  PropertyLabel,
  Property,
  Row,
  indexedDb,
  StoreName,
} from "client";
import { CASH_TICKER } from "../HoldingsComposition";
import { HoldingSnapshotPostResponse, ValidateTickerResponse } from "server";

import "./index.css";

const toDateInputValue = (d: Date) => d.toISOString().split("T")[0];

const toIsoDateInput = (raw: string | null | undefined): string => {
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : toDateInputValue(date);
};

interface NewHoldingForm {
  ticker: string;
  quantity: string;
  costBasis: string;
}

const EMPTY_FORM: NewHoldingForm = { ticker: "", quantity: "", costBasis: "" };

interface SecurityInfo {
  security_id: string | null;
  ticker_symbol: string | null;
  name: string | null;
}

export const HoldingProperties = () => {
  const { router, viewDate, data, setData, calculations } = useAppContext();

  const activeParams = router.getActiveParams(PATH.HOLDING_DETAIL);
  const accountId = activeParams.get("account_id") || "";
  const ticker = activeParams.get("ticker") || "";
  const isNew = !ticker;

  // Edit gating mirrors AccountProperties' balance input: synced accounts
  // are not editable at the current viewDate, because that state is
  // broker-derived and would diverge from the next sync. Manual accounts
  // are always editable. Past viewDates (manual or synced) edit the
  // underlying snapshot, same model as account-snapshot balance edits.
  const account = data.accounts.get(accountId);
  const item = account ? data.items.get(account.item_id) : undefined;
  const isManualAccount = item?.provider === ItemProvider.MANUAL;
  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isCurrentViewDate = viewDate.getEndDate() >= latestViewDate.getEndDate();
  const isReadOnly = !isManualAccount && isCurrentViewDate;

  // Resolve which (account, security_id) entries belong to this ticker
  // bucket — single source of truth = `holdingsValueData.getHoldingsForAccount`,
  // the same hook HoldingsComposition uses. Then look up the LATEST holding
  // snapshot per security_id (≤ viewDate) so each per-security row in the
  // bucket gets an editable underlying snapshot. Using `holdingsValueData`
  // here keeps the detail page's contributing set strictly equal to the
  // table's bucket members — without it, the detail page could pull in
  // snapshots the table excluded (or miss snapshots the table included).
  // The `?ticker=` URL param holds the canonical bucket key as produced by
  // HoldingsComposition: an uppercased real ticker, `__CASH__`, or a raw
  // (case-preserved) security_id for no-ticker fallback. Don't uppercase
  // here — that would corrupt the security_id case in the fallback path.
  const tickerKey = ticker;
  const viewEndDate = viewDate.getEndDate();
  const { holdingsValueData } = calculations;

  const bucketSnapshots = useMemo<HoldingSnapshot[]>(() => {
    if (isNew) return [];

    // Step 1: identify which (account, security_id) pairs the calculation
    // hook would aggregate into this ticker bucket. Same rule as
    // HoldingsComposition: real ticker wins, `__CASH__` reserved for cash,
    // non-cash row with ticker `__CASH__` falls back to full security_id.
    const bucketSecurityIds = new Set<string>();
    const holdingIds = holdingsValueData.getHoldingsForAccount(accountId);
    holdingIds.forEach((holdingId) => {
      const summary = holdingsValueData.getHistory(holdingId).get(viewEndDate);
      if (!summary || summary.value === 0) return;
      const securityMatch = data.securitySnapshots.find(
        (s) => s.security.security_id === summary.security_id,
      );
      const snapTicker = securityMatch?.security.ticker_symbol?.toUpperCase() ?? null;
      const isCash = summary.isCash;
      const snapBucket = isCash
        ? CASH_TICKER
        : snapTicker && snapTicker !== CASH_TICKER
          ? snapTicker
          : summary.security_id;
      if (snapBucket === tickerKey) bucketSecurityIds.add(summary.security_id);
    });

    // Step 2: for each contributing security_id, find the latest snapshot
    // (date ≤ viewEndDate) so the per-snapshot section can render an
    // editable form. One section per security_id; the freshest snapshot
    // wins when multiple exist on the same date.
    const latestPerSecurity = new Map<string, HoldingSnapshot>();
    data.holdingSnapshots.forEach((snap) => {
      if (snap.holding.account_id !== accountId) return;
      if (!bucketSecurityIds.has(snap.holding.security_id)) return;
      const snapDate = new Date(snap.snapshot.date);
      if (snapDate > viewEndDate) return;
      const existing = latestPerSecurity.get(snap.holding.security_id);
      if (!existing || new Date(existing.snapshot.date) < snapDate) {
        latestPerSecurity.set(snap.holding.security_id, snap);
      }
    });

    return Array.from(latestPerSecurity.values()).sort(
      (a, b) => new Date(b.snapshot.date).getTime() - new Date(a.snapshot.date).getTime(),
    );
  }, [
    accountId,
    data.holdingSnapshots,
    data.securitySnapshots,
    holdingsValueData,
    isNew,
    tickerKey,
    viewEndDate,
  ]);

  // Bucket-level display info — primary label, name (first non-null), and
  // a representative security record (used by the per-snapshot sections).
  const bucketInfo = useMemo<{
    primaryLabel: string;
    name: string | null;
    securities: Map<string, SecurityInfo>;
  }>(() => {
    const securities = new Map<string, SecurityInfo>();
    let name: string | null = null;
    bucketSnapshots.forEach((snap) => {
      const sid = snap.holding.security_id;
      if (!securities.has(sid)) {
        const match = data.securitySnapshots.find((s) => s.security.security_id === sid);
        securities.set(sid, {
          security_id: sid,
          ticker_symbol: match?.security.ticker_symbol ?? null,
          name: match?.security.name?.trim() || null,
        });
      }
      if (!name) name = securities.get(sid)?.name ?? null;
    });
    const primaryLabel = tickerKey === CASH_TICKER ? "Cash" : tickerKey;
    return { primaryLabel, name, securities };
  }, [bucketSnapshots, data.securitySnapshots, tickerKey]);

  const isCash = tickerKey === CASH_TICKER;
  const currencySymbol = currencyCodeToSymbol(
    bucketSnapshots[0]?.holding.iso_currency_code || "USD",
  );

  // Aggregate quantity / cost basis across all underlying snapshots.
  // Avg cost basis = sum(cost_basis) / sum(quantity); null whenever any
  // contributor lacks cost basis OR total quantity is zero.
  const aggregate = useMemo(() => {
    const totals = bucketSnapshots.reduce(
      (acc, s) => {
        acc.quantity += s.holding.quantity ?? 0;
        if (acc.allHaveCostBasis && s.holding.cost_basis != null) {
          acc.costBasisTotal += s.holding.cost_basis;
        } else {
          acc.allHaveCostBasis = false;
        }
        return acc;
      },
      { quantity: 0, costBasisTotal: 0, allHaveCostBasis: true },
    );
    const avgCostBasis =
      totals.allHaveCostBasis && totals.quantity !== 0
        ? totals.costBasisTotal / totals.quantity
        : null;
    return {
      totalQuantity: totals.quantity,
      avgCostBasis,
    };
  }, [bucketSnapshots]);

  const loadError =
    !isNew && bucketSnapshots.length === 0 ? "No holdings recorded for this ticker." : "";

  // Per-snapshot edit state — keyed by snapshot_id. We track input values
  // separately from the snapshot data so edits stay isolated per row.
  const [snapEdits, setSnapEdits] = useState<
    Record<string, { quantity: string; costBasis: string; date: string; error: string }>
  >({});

  useEffect(() => {
    setSnapEdits((prev) => {
      const next: typeof prev = {};
      bucketSnapshots.forEach((snap) => {
        const id = snap.snapshot.snapshot_id;
        const existing = prev[id];
        // Hydrate from snapshot on first mount; preserve in-progress edits
        // across re-renders triggered by sync (data updates) so the user
        // doesn't lose typed input.
        if (existing) {
          next[id] = existing;
        } else {
          next[id] = {
            quantity: snap.holding.quantity != null ? String(snap.holding.quantity) : "",
            costBasis: snap.holding.cost_basis != null ? String(snap.holding.cost_basis) : "",
            date: toIsoDateInput(snap.snapshot.date),
            error: "",
          };
        }
      });
      return next;
    });
  }, [bucketSnapshots]);

  const [form, setForm] = useState<NewHoldingForm>(EMPTY_FORM);
  const [snapshotDateInput, setSnapshotDateInput] = useState(
    toDateInputValue(viewDate.getEndDate()),
  );
  const [tickerStatus, setTickerStatus] = useState<"idle" | "validating" | "valid" | "invalid">(
    "idle",
  );
  const [tickerMessage, setTickerMessage] = useState("");
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    if (isNew) setSnapshotDateInput(toDateInputValue(viewDate.getEndDate()));
  }, [isNew, viewDate]);

  const onChangeField =
    (field: keyof NewHoldingForm): ChangeEventHandler<HTMLInputElement> =>
    (e) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      if (field === "ticker") {
        setTickerStatus("idle");
        setTickerMessage("");
      }
    };

  const onValidateTicker = async () => {
    const ticker = form.ticker.trim().toUpperCase();
    if (!ticker) return;
    setTickerStatus("validating");
    setTickerMessage("");
    const r = await call
      .post<ValidateTickerResponse>("/api/validate-ticker", { ticker_symbol: ticker, save: false })
      .catch(console.error);
    if (r?.status === "success" && r.body) {
      if (r.body.valid) {
        setTickerStatus("valid");
        setTickerMessage(r.body.security?.name || "Valid ticker");
        setForm((prev) => ({ ...prev, ticker }));
      } else {
        setTickerStatus("invalid");
        setTickerMessage(r.body.message || "Invalid ticker symbol");
      }
    } else {
      setTickerStatus("invalid");
      setTickerMessage("Validation failed — check the ticker symbol");
    }
  };

  /**
   * `Add Investment Transaction` on the holding — Hoie's ask (#585
   * design): prefill `security_id`, `price` (from the holding's
   * `institution_price`), and `iso_currency_code` from the holding
   * context so the user starts with values they can confirm/correct
   * rather than 0 / null defaults. When the bucket spans multiple
   * securities (rare — merged tickers), use the first snapshot.
   */
  const primaryHolding = bucketSnapshots[0]?.holding;
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
      holdingSnapshots: data.holdingSnapshots,
      investmentTransactions: data.investmentTransactions,
      securitySnapshots: data.securitySnapshots,
    },
    viewEndDate.toISOString().slice(0, 10),
  );
  // Second computation at TODAY — the button's presence tracks the
  // security's LATEST unreconciled surplus, not just the current view's
  // window. This lets the user reach the reconcile action from any
  // past view (Hoie 2026-07-06: "buttons exist in June but not in May
  // or April"). Reason for the mismatch: divergence at a past view can
  // fire for a DIFFERENT security than the one the user is inspecting
  // (widget footnote aggregates across the account), or the current
  // holding's snapshot history might not extend that far back — either
  // way the per-viewDate map wouldn't include the security. Using the
  // today-anchored divergence gates the button on "does this security
  // still have unreconciled shares", which is a property of the data
  // rather than the viewDate.
  const divergenceNow = useHoldingDivergence(
    accountId ? [accountId] : [],
    {
      holdingSnapshots: data.holdingSnapshots,
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
  // after the jump. (Hoie 2026-07-06 report: added missing invtx and
  // warnings didn't clear for any view dates.)
  const reconcileDate = useMemo(() => {
    if (!primarySecurityId || !accountId) return undefined;
    const snaps: { date: string; qty: number }[] = [];
    data.holdingSnapshots.forEach((snap) => {
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
  }, [data.holdingSnapshots, accountId, primarySecurityId]);
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

  const goBackToAccount = () => {
    if (!accountId) {
      router.go(PATH.ACCOUNTS);
      return;
    }
    const back = new URLSearchParams();
    back.set("account_id", accountId);
    router.go(PATH.ACCOUNT_DETAIL, { params: back });
  };

  const onSubmitNew: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setSubmitError("");

    const ticker = form.ticker.trim().toUpperCase();
    const quantity = parseFloat(form.quantity);
    const costBasis = form.costBasis.trim() ? parseFloat(form.costBasis) : undefined;

    if (!ticker) return setSubmitError("Ticker symbol is required");
    if (Number.isNaN(quantity) || quantity <= 0)
      return setSubmitError("Quantity must be a positive number");
    if (costBasis !== undefined && Number.isNaN(costBasis))
      return setSubmitError("Cost basis must be a number");
    if (!snapshotDateInput) return setSubmitError("Snapshot date is required");

    const body: Record<string, unknown> = {
      account_id: accountId,
      ticker_symbol: ticker,
      quantity,
      snapshot_date: snapshotDateInput,
    };
    if (costBasis !== undefined) body.cost_basis = costBasis;

    const r = await call
      .post<HoldingSnapshotPostResponse>("/api/snapshots/holding", body)
      .catch(console.error);

    if (r?.status !== "success" || !r.body) {
      setSubmitError(r?.message || "Failed to save holding");
      return;
    }
    // Same client-side propagation as updateField — insert the newly created
    // snapshot into appContext.data so the composition table updates without
    // a round-trip through /api/snapshots.
    const { snapshot_id: newSnapshotId, security_id: newSecurityId } = r.body;
    const newSnapshot = new HoldingSnapshot({
      snapshot: new Snapshot({
        snapshot_id: newSnapshotId,
        date: new Date(snapshotDateInput).toISOString(),
      }),
      holding: new Holding({
        account_id: accountId,
        security_id: newSecurityId,
        quantity,
        cost_basis: costBasis ?? null,
        institution_price: 0,
        institution_value: 0,
        institution_price_as_of: snapshotDateInput,
      }),
    });
    setData((oldData) => {
      const newData = new Data(oldData);
      indexedDb.save(newSnapshot).catch(console.error);
      const next = new HoldingSnapshotDictionary(newData.holdingSnapshots);
      next.set(newSnapshotId, newSnapshot);
      newData.holdingSnapshots = next;
      return newData;
    });
    goBackToAccount();
  };

  /** Patch a single underlying snapshot (per-snapshot two-row section). */
  const updateSnapshot = useCallback(
    async (snap: HoldingSnapshot, patch: Record<string, unknown>) => {
      const r = await call
        .post<HoldingSnapshotPostResponse>("/api/snapshots/holding", {
          snapshot_id: snap.snapshot.snapshot_id,
          ...patch,
        })
        .catch(console.error);
      if (r?.status !== "success" || !r.body) {
        setSnapEdits((prev) => ({
          ...prev,
          [snap.snapshot.snapshot_id]: {
            ...(prev[snap.snapshot.snapshot_id] ?? {
              quantity: "",
              costBasis: "",
              date: "",
              error: "",
            }),
            error: r?.message || "Failed to update holding",
          },
        }));
        return;
      }
      const { snapshot_id: returnedSnapshotId, security_id: returnedSecurityId } = r.body;
      const nextHolding = new Holding({
        ...snap.holding,
        security_id: returnedSecurityId,
        quantity: "quantity" in patch ? (patch.quantity as number) : snap.holding.quantity,
        cost_basis:
          "cost_basis" in patch ? (patch.cost_basis as number | null) : snap.holding.cost_basis,
        institution_price:
          "institution_price" in patch
            ? (patch.institution_price as number)
            : snap.holding.institution_price,
        institution_value:
          "institution_value" in patch
            ? (patch.institution_value as number)
            : snap.holding.institution_value,
      });
      const nextDate =
        "snapshot_date" in patch && typeof patch.snapshot_date === "string"
          ? new Date(patch.snapshot_date).toISOString()
          : snap.snapshot.date;
      const nextSnapshot = new HoldingSnapshot({
        snapshot: new Snapshot({ snapshot_id: returnedSnapshotId, date: nextDate }),
        user: snap.user,
        holding: nextHolding,
      });
      setData((oldData) => {
        const newData = new Data(oldData);
        indexedDb.save(nextSnapshot).catch(console.error);
        const next = new HoldingSnapshotDictionary(newData.holdingSnapshots);
        next.set(returnedSnapshotId, nextSnapshot);
        newData.holdingSnapshots = next;
        return newData;
      });
    },
    [setData],
  );

  const onBlurQuantity = (snap: HoldingSnapshot, raw: string) => async () => {
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) {
      setSnapEdits((prev) => ({
        ...prev,
        [snap.snapshot.snapshot_id]: {
          ...prev[snap.snapshot.snapshot_id],
          error: "Quantity must be a number",
        },
      }));
      return;
    }
    if (parsed === snap.holding.quantity) return;
    await updateSnapshot(snap, { quantity: parsed });
  };

  const onBlurCostBasis = (snap: HoldingSnapshot, raw: string) => async () => {
    if (raw.trim() === "") {
      if (snap.holding.cost_basis == null) return;
      await updateSnapshot(snap, { cost_basis: null });
      return;
    }
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) {
      setSnapEdits((prev) => ({
        ...prev,
        [snap.snapshot.snapshot_id]: {
          ...prev[snap.snapshot.snapshot_id],
          error: "Cost basis must be a number",
        },
      }));
      return;
    }
    if (parsed === snap.holding.cost_basis) return;
    await updateSnapshot(snap, { cost_basis: parsed });
  };

  const onBlurDate = (snap: HoldingSnapshot, raw: string) => async () => {
    if (!raw) return;
    if (raw === toIsoDateInput(snap.snapshot.date)) return;
    await updateSnapshot(snap, { snapshot_date: raw });
  };

  const onClickDeleteSnap = (snap: HoldingSnapshot) => async () => {
    if (!window.confirm("Remove this holding snapshot?")) return;
    const removedId = snap.snapshot.snapshot_id;
    const r = await call.delete(`/api/snapshots/holding?id=${removedId}`).catch(console.error);
    if (r?.status !== "success") {
      setSnapEdits((prev) => ({
        ...prev,
        [removedId]: {
          ...prev[removedId],
          error: r?.message || "Failed to delete holding",
        },
      }));
      return;
    }
    setData((oldData) => {
      const newData = new Data(oldData);
      indexedDb.remove(StoreName.holdingSnapshots, removedId).catch(console.error);
      const next = new HoldingSnapshotDictionary(newData.holdingSnapshots);
      next.delete(removedId);
      newData.holdingSnapshots = next;
      return newData;
    });
    // If we just deleted the last underlying snapshot, the bucket is empty
    // and there's nothing more to render — go back.
    if (bucketSnapshots.length <= 1) goBackToAccount();
  };

  if (!accountId) {
    return (
      <Properties className="HoldingProperties">
        <PropertyLabel>Holding</PropertyLabel>
        <Property>
          <Row className="keyValue">
            <span className="propertyName">Missing&nbsp;account&nbsp;context</span>
            <span></span>
          </Row>
        </Property>
      </Properties>
    );
  }

  if (isNew) {
    return (
      <Properties className="HoldingProperties">
        <PropertyLabel>New&nbsp;Holding</PropertyLabel>
        {/* The `<Property>` wrapper keeps the `.property` styling on a
            direct child of `<Properties>`. The inner `<form>` carries the
            submit handler but doesn't need any class — `<Row>` rules
            cascade via descendant selectors. */}
        <Property>
          <form onSubmit={onSubmitNew}>
            <Row className="keyValue">
              <span className="propertyName">Ticker</span>
              <div className="tickerField">
                <input
                  type="text"
                  placeholder="e.g. AAPL"
                  value={form.ticker}
                  onChange={onChangeField("ticker")}
                  autoCapitalize="characters"
                />
                <button type="button" className="validateBtn" onClick={onValidateTicker}>
                  {tickerStatus === "validating" ? "…" : "Check"}
                </button>
              </div>
            </Row>
            {tickerMessage && (
              <Row className={`tickerFeedback ${tickerStatus}`}>{tickerMessage}</Row>
            )}
            <Row className="keyValue">
              <span className="propertyName">Quantity</span>
              <input
                type="number"
                placeholder="0"
                min="0"
                step="any"
                value={form.quantity}
                onChange={onChangeField("quantity")}
              />
            </Row>
            <Row className="keyValue">
              <span className="propertyName">Cost&nbsp;basis&nbsp;(opt)</span>
              <input
                type="number"
                placeholder="Total $ paid (all shares)"
                min="0"
                step="any"
                value={form.costBasis}
                onChange={onChangeField("costBasis")}
              />
            </Row>
            <Row className="keyValue">
              <span className="propertyName">Snapshot&nbsp;date</span>
              <input
                type="date"
                value={snapshotDateInput}
                onChange={(e) => setSnapshotDateInput(e.target.value)}
              />
            </Row>
            {submitError && <Row className="formError">{submitError}</Row>}
            <Row className="button">
              <button type="submit" className="colored">
                Add
              </button>
            </Row>
            <Row className="button">
              <button type="button" onClick={goBackToAccount}>
                Cancel
              </button>
            </Row>
          </form>
        </Property>
      </Properties>
    );
  }

  if (loadError) {
    return (
      <Properties className="HoldingProperties">
        <PropertyLabel>Holding</PropertyLabel>
        <Property>
          <Row className="formError">{loadError}</Row>
        </Property>
        <PropertyLabel>&nbsp;</PropertyLabel>
        <Property>
          <Row className="button">
            <button type="button" onClick={goBackToAccount}>
              Back
            </button>
          </Row>
        </Property>
      </Properties>
    );
  }

  return (
    <Properties className="HoldingProperties">
      <PropertyLabel>Holding</PropertyLabel>
      <Property>
        <Row className="keyValue">
          <span className="propertyName">Ticker</span>
          <span>{bucketInfo.primaryLabel}</span>
        </Row>
        {bucketInfo.name && (
          <Row className="keyValue">
            <span className="propertyName">Name</span>
            <span>{bucketInfo.name}</span>
          </Row>
        )}
        <Row className="keyValue">
          <span className="propertyName">{isCash ? "Amount" : "Quantity"}</span>
          <span>
            {numberToCommaString(aggregate.totalQuantity, isCash ? 2 : 4)}
            {isCash && <span className="currencyMeta">&nbsp;{currencySymbol}</span>}
          </span>
        </Row>
        {!isCash && (
          <Row className="keyValue">
            <span className="propertyName">Cost&nbsp;basis&nbsp;(avg)</span>
            <span>
              {aggregate.avgCostBasis !== null
                ? numberToCommaString(aggregate.avgCostBasis, 4)
                : "—"}
            </span>
          </Row>
        )}
      </Property>

      {bucketSnapshots.map((snap, idx) => {
        const id = snap.snapshot.snapshot_id;
        const edit = snapEdits[id] ?? {
          quantity: "",
          costBasis: "",
          date: "",
          error: "",
        };
        const setEdit = (patch: Partial<typeof edit>) =>
          setSnapEdits((prev) => ({ ...prev, [id]: { ...edit, ...patch } }));
        // <Fragment> keeps the per-snapshot <PropertyLabel> + <Property>
        // pair as DIRECT children of <Properties> — no wrapper div. See
        // PR #478 for the regression this guards against.
        return (
          <Fragment key={id}>
            {/* Suffix is `security_id` — sections are grouped by security
                so this is the distinguishing identity. NOT the snapshot
                date (misread as "same holding, different dates" and made
                summing look wrong) and NOT the holding_id (a composite
                that repeats the account_id across every section). */}
            <PropertyLabel>
              Snapshot&nbsp;{idx + 1}
              <span className="snapshotMeta">&nbsp;·&nbsp;{snap.holding.security_id}</span>
            </PropertyLabel>
            <Property>
              <Row className="keyValue">
                <span className="propertyName">{isCash ? "Amount" : "Quantity"}</span>
                {isReadOnly ? (
                  <span>
                    {edit.quantity || "—"}
                    {isCash && edit.quantity && (
                      <span className="currencyMeta">&nbsp;{currencySymbol}</span>
                    )}
                  </span>
                ) : (
                  <span className="inputWithSuffix">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={edit.quantity}
                      onChange={(e) => setEdit({ quantity: e.target.value, error: "" })}
                      onBlur={onBlurQuantity(snap, edit.quantity)}
                    />
                    {isCash && <span className="currencyMeta">{currencySymbol}</span>}
                  </span>
                )}
              </Row>
              {!isCash && (
                <Row className="keyValue">
                  <span className="propertyName">Cost&nbsp;basis</span>
                  {isReadOnly ? (
                    <span>{edit.costBasis || "—"}</span>
                  ) : (
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={edit.costBasis}
                      onChange={(e) => setEdit({ costBasis: e.target.value, error: "" })}
                      onBlur={onBlurCostBasis(snap, edit.costBasis)}
                    />
                  )}
                </Row>
              )}
              <Row className="keyValue">
                <span className="propertyName">Snapshot&nbsp;date</span>
                {isReadOnly ? (
                  <span>{edit.date || "—"}</span>
                ) : (
                  <input
                    type="date"
                    value={edit.date}
                    onChange={(e) => setEdit({ date: e.target.value, error: "" })}
                    onBlur={onBlurDate(snap, edit.date)}
                  />
                )}
              </Row>
              {edit.error && <Row className="formError">{edit.error}</Row>}
              {!isReadOnly && (
                <Row className="button">
                  <button
                    type="button"
                    className="delete colored"
                    onClick={onClickDeleteSnap(snap)}
                  >
                    Remove&nbsp;this&nbsp;snapshot
                  </button>
                </Row>
              )}
            </Property>
          </Fragment>
        );
      })}

      {!isNew && !isCash && (
        <>
          <PropertyLabel>Add</PropertyLabel>
          <Property>
            <Row className="button">
              <button type="button" onClick={onClickAddInvestmentTransaction}>
                Add&nbsp;Investment&nbsp;Transaction
              </button>
            </Row>
            {missingUnits > 0 && (
              <Row className="button">
                <button
                  type="button"
                  className="divergenceAction"
                  onClick={onClickAddDivergentTransaction}
                >
                  Add&nbsp;transaction&nbsp;for&nbsp;
                  {numberToCommaString(missingUnits, 4)}&nbsp;missing&nbsp;units
                </button>
              </Row>
            )}
          </Property>
        </>
      )}

      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <Row className="button">
          <button type="button" onClick={goBackToAccount}>
            Back
          </button>
        </Row>
      </Property>
    </Properties>
  );
};
