import { ChangeEventHandler, FormEventHandler, useCallback, useEffect, useState } from "react";
import { call, useAppContext } from "client";
import {
  HoldingSnapshotWithSecurity,
  GetHoldingSnapshotsResponse,
  HoldingSnapshotPostResponse,
  ValidateTickerResponse,
} from "server";
import "./index.css";

interface Props {
  accountId: string;
}

interface NewHoldingForm {
  ticker: string;
  quantity: string;
  costBasis: string;
}

const EMPTY_FORM: NewHoldingForm = { ticker: "", quantity: "", costBasis: "" };

const toDateInputValue = (d: Date) => d.toISOString().split("T")[0];

export const HoldingsManager = ({ accountId }: Props) => {
  const { viewDate } = useAppContext();

  const [snapshots, setSnapshots] = useState<HoldingSnapshotWithSecurity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
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
    setSnapshotDateInput(toDateInputValue(viewDate.getEndDate()));
  }, [viewDate]);

  const fetchSnapshots = useCallback(async () => {
    setIsLoading(true);
    const r = await call
      .get<GetHoldingSnapshotsResponse>(`/api/snapshots/holding?account_id=${accountId}`)
      .catch(console.error);
    if (r?.status === "success" && r.body) {
      setSnapshots(r.body.snapshots);
    }
    setIsLoading(false);
  }, [accountId]);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

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
        setForm((prev) => ({ ...prev, ticker: ticker }));
      } else {
        setTickerStatus("invalid");
        setTickerMessage(r.body.message || "Invalid ticker symbol");
      }
    } else {
      setTickerStatus("invalid");
      setTickerMessage("Validation failed — check the ticker symbol");
    }
  };

  const onSubmit: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setSubmitError("");

    const ticker = form.ticker.trim().toUpperCase();
    const quantity = parseFloat(form.quantity);
    const costBasis = form.costBasis.trim() ? parseFloat(form.costBasis) : undefined;

    if (!ticker) return setSubmitError("Ticker symbol is required");
    if (isNaN(quantity) || quantity <= 0)
      return setSubmitError("Quantity must be a positive number");
    if (costBasis !== undefined && isNaN(costBasis))
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

    if (r?.status === "success") {
      setForm(EMPTY_FORM);
      setTickerStatus("idle");
      setTickerMessage("");
      setIsAdding(false);
      await fetchSnapshots();
    } else {
      setSubmitError(r?.message || "Failed to save holding");
    }
  };

  const onDelete = async (snapshotId: string) => {
    if (!window.confirm("Remove this holding snapshot?")) return;
    const r = await call.delete(`/api/snapshots/holding?id=${snapshotId}`).catch(console.error);
    if (r?.status === "success") {
      setSnapshots((prev) => prev.filter((s) => s.snapshot_id !== snapshotId));
    }
  };

  const onCancelAdd = () => {
    setIsAdding(false);
    setForm(EMPTY_FORM);
    setTickerStatus("idle");
    setTickerMessage("");
    setSubmitError("");
  };

  const renderHoldings = () => {
    if (isLoading) {
      return (
        <div className="row">
          <span className="propertyName">Loading…</span>
        </div>
      );
    }
    if (snapshots.length === 0) {
      return (
        <div className="row">
          <span className="propertyName disabled">No holdings recorded</span>
        </div>
      );
    }
    return snapshots.map((s) => {
      const ticker = s.ticker_symbol || s.holding_security_id.slice(0, 8);
      const qty = s.quantity != null ? `${s.quantity} sh` : "—";
      const detail = [
        s.cost_basis != null ? `$${s.cost_basis.toFixed(2)}/sh` : null,
        s.snapshot_date?.slice(0, 10) ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        <div key={s.snapshot_id} className="row keyValue">
          <span className="propertyName" title={s.security_name || undefined}>
            {ticker}
          </span>
          <span className="holdingDetail">
            <span>{qty}</span>
            {detail && <span className="small">{detail}</span>}
            <button
              type="button"
              className="holdingDelete"
              aria-label={`Remove ${ticker}`}
              onClick={() => onDelete(s.snapshot_id)}
            >
              ×
            </button>
          </span>
        </div>
      );
    });
  };

  return (
    <>
      <div className="propertyLabel">Holdings</div>

      {isAdding ? (
        <form className="property" onSubmit={onSubmit}>
          {renderHoldings()}
          <div className="row keyValue">
            <label className="propertyName" htmlFor="holding-ticker">
              Ticker
            </label>
            <div className="tickerField">
              <input
                id="holding-ticker"
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
          </div>
          {tickerMessage && (
            <div className={`row tickerFeedback ${tickerStatus}`}>{tickerMessage}</div>
          )}
          <div className="row keyValue">
            <label className="propertyName" htmlFor="holding-qty">
              Quantity
            </label>
            <input
              id="holding-qty"
              type="number"
              placeholder="0"
              min="0"
              step="any"
              value={form.quantity}
              onChange={onChangeField("quantity")}
            />
          </div>
          <div className="row keyValue">
            <label className="propertyName" htmlFor="holding-cost">
              Cost/sh&nbsp;(opt)
            </label>
            <input
              id="holding-cost"
              type="number"
              placeholder="0.00"
              min="0"
              step="any"
              value={form.costBasis}
              onChange={onChangeField("costBasis")}
            />
          </div>
          <div className="row keyValue">
            <label className="propertyName" htmlFor="holding-date">
              Snapshot&nbsp;date
            </label>
            <input
              id="holding-date"
              type="date"
              value={snapshotDateInput}
              onChange={(e) => setSnapshotDateInput(e.target.value)}
            />
          </div>
          {submitError && <div className="row formError">{submitError}</div>}
          <div className="row button">
            <button type="submit" className="colored">
              Add
            </button>
          </div>
          <div className="row button">
            <button type="button" onClick={onCancelAdd}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="property">
          {renderHoldings()}
          <div className="row button">
            <button type="button" onClick={() => setIsAdding(true)}>
              Add&nbsp;Holding
            </button>
          </div>
        </div>
      )}
    </>
  );
};
