import {
  ChangeEventHandler,
  FormEventHandler,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ItemProvider, numberToCommaString, ViewDate, currencyCodeToSymbol } from "common";
import {
  call,
  PATH,
  useAppContext,
  Data,
  Snapshot,
  Holding,
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  Properties,
  PropertyLabel,
  Property,
  ButtonRow,
  Row,
  KeyValue,
  indexedDb,
} from "client";
import { CASH_TICKER } from "../HoldingsComposition";
import { HoldingSnapshotPostResponse, ValidateTickerResponse } from "server";
import { SnapshotManager } from "./SnapshotManager";
import { HoldingTransactionActions } from "./HoldingTransactionActions";

import "./index.css";

const toDateInputValue = (d: Date) => d.toISOString().split("T")[0];

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
      const snapTicker =
        (
          data.securities.get(summary.security_id)?.ticker_symbol ||
          securityMatch?.security.ticker_symbol
        )?.toUpperCase() ?? null;
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
    calculations.holdingSnapshots.forEach((snap) => {
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
    calculations.holdingSnapshots,
    data.securities,
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
        const security = data.securities.get(sid);
        securities.set(sid, {
          security_id: sid,
          ticker_symbol: security?.ticker_symbol || match?.security.ticker_symbol || null,
          name: security?.name?.trim() || match?.security.name?.trim() || null,
        });
      }
      if (!name) name = securities.get(sid)?.name ?? null;
    });
    const primaryLabel = tickerKey === CASH_TICKER ? "Cash" : tickerKey;
    return { primaryLabel, name, securities };
  }, [bucketSnapshots, data.securities, data.securitySnapshots, tickerKey]);

  const isCash = tickerKey === CASH_TICKER;
  const currencySymbol = currencyCodeToSymbol(
    bucketSnapshots[0]?.holding.iso_currency_code,
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
      // The route rejects with a message of its own when the lookup was shed
      // rather than answered; showing the generic line instead would blame
      // the symbol for a server-side cap.
      setTickerMessage(r?.message ?? "Validation failed — check the ticker symbol");
    }
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

  if (!accountId) {
    return (
      <Properties className="HoldingProperties">
        <PropertyLabel>Holding</PropertyLabel>
        <Property>
          <KeyValue name="Missing&nbsp;account&nbsp;context">
            <span></span>
          </KeyValue>
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
            <KeyValue name="Ticker">
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
            </KeyValue>
            {tickerMessage && (
              <Row className={`tickerFeedback ${tickerStatus}`}>{tickerMessage}</Row>
            )}
            <KeyValue name="Quantity">
              <input
                type="number"
                placeholder="0"
                min="0"
                step="any"
                value={form.quantity}
                onChange={onChangeField("quantity")}
              />
            </KeyValue>
            <KeyValue name="Cost&nbsp;basis&nbsp;(opt)">
              <input
                type="number"
                placeholder="Total $ paid (all shares)"
                min="0"
                step="any"
                value={form.costBasis}
                onChange={onChangeField("costBasis")}
              />
            </KeyValue>
            <KeyValue name="Snapshot&nbsp;date">
              <input
                type="date"
                value={snapshotDateInput}
                onChange={(e) => setSnapshotDateInput(e.target.value)}
              />
            </KeyValue>
            {submitError && <Row className="formError">{submitError}</Row>}
            <ButtonRow type="submit">
              Add
            </ButtonRow>
            <ButtonRow type="button" onClick={goBackToAccount}>
              Cancel
            </ButtonRow>
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
          <ButtonRow type="button" onClick={goBackToAccount}>
            Back
          </ButtonRow>
        </Property>
      </Properties>
    );
  }

  return (
    <Properties className="HoldingProperties">
      <PropertyLabel>Holding</PropertyLabel>
      <Property>
        <KeyValue name="Ticker">
          <span>{bucketInfo.primaryLabel}</span>
        </KeyValue>
        {bucketInfo.name && (
          <KeyValue name="Name">
            <span>{bucketInfo.name}</span>
          </KeyValue>
        )}
        <KeyValue name={isCash ? "Amount" : "Quantity"}>
          <span>
            {numberToCommaString(aggregate.totalQuantity, isCash ? 2 : 4)}
            {isCash && <span className="currencyMeta">&nbsp;{currencySymbol}</span>}
          </span>
        </KeyValue>
        {!isCash && (
          <KeyValue name="Cost&nbsp;basis&nbsp;(avg)">
            <span>
              {aggregate.avgCostBasis !== null
                ? numberToCommaString(aggregate.avgCostBasis, 4)
                : "—"}
            </span>
          </KeyValue>
        )}
      </Property>

      <SnapshotManager
        snapshots={bucketSnapshots}
        isCash={isCash}
        isReadOnly={isReadOnly}
        currencySymbol={currencySymbol}
        onEmpty={goBackToAccount}
      />

      {!isNew && !isCash && (
        <HoldingTransactionActions accountId={accountId} snapshots={bucketSnapshots} />
      )}

      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <ButtonRow type="button" onClick={goBackToAccount}>
          Back
        </ButtonRow>
      </Property>
    </Properties>
  );
};
