import { ChangeEventHandler, FormEventHandler, useCallback, useEffect, useState } from "react";
import { ItemProvider, ViewDate } from "common";
import { call, PATH, useAppContext } from "client";
import {
  GetHoldingSnapshotsResponse,
  HoldingSnapshotPostResponse,
  HoldingSnapshotWithSecurity,
  ValidateTickerResponse,
} from "server";

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

export const HoldingProperties = () => {
  const { router, viewDate, data } = useAppContext();
  const { path, params, transition } = router;
  const activeParams = path === PATH.HOLDING_DETAIL ? params : transition.incomingParams;

  const accountId = activeParams.get("account_id") || "";
  const snapshotId = activeParams.get("snapshot_id") || "";
  const isNew = !snapshotId;

  // Edit gating mirrors AccountProperties' balance input (Hoie 2026-05-15):
  // synced accounts are not editable at the current viewDate, because that
  // state is broker-derived and would diverge from the next sync. Manual
  // accounts are always editable. Past viewDates (manual or synced) edit
  // the underlying snapshot, same model as account-snapshot balance edits.
  const account = data.accounts.get(accountId);
  const item = account ? data.items.get(account.item_id) : undefined;
  const isManualAccount = item?.provider === ItemProvider.MANUAL;
  const latestViewDate = new ViewDate(viewDate.getInterval());
  const isCurrentViewDate = viewDate.getEndDate() >= latestViewDate.getEndDate();
  const isReadOnly = !isManualAccount && isCurrentViewDate;

  const [snapshot, setSnapshot] = useState<HoldingSnapshotWithSecurity | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [editTicker, setEditTicker] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editCostBasis, setEditCostBasis] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editError, setEditError] = useState("");

  const fetchSnapshot = useCallback(async () => {
    if (!snapshotId || !accountId) return;
    setLoading(true);
    setLoadError("");
    const r = await call
      .get<GetHoldingSnapshotsResponse>(`/api/snapshots/holding?account_id=${accountId}`)
      .catch(console.error);
    if (r?.status === "success" && r.body) {
      const found = r.body.snapshots.find((s) => s.snapshot_id === snapshotId);
      if (found) {
        setSnapshot(found);
        setEditTicker(found.ticker_symbol || "");
        setEditQuantity(found.quantity != null ? String(found.quantity) : "");
        setEditCostBasis(found.cost_basis != null ? String(found.cost_basis) : "");
        setEditDate(toIsoDateInput(found.snapshot_date));
      } else {
        setLoadError("Holding not found.");
      }
    } else {
      setLoadError(r?.message || "Failed to load holding.");
    }
    setLoading(false);
  }, [accountId, snapshotId]);

  useEffect(() => {
    if (!isNew) fetchSnapshot();
  }, [isNew, fetchSnapshot]);

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

    if (r?.status === "success") {
      window.dispatchEvent(
        new CustomEvent("holdings-updated", { detail: { account_id: accountId } }),
      );
      goBackToAccount();
    } else {
      setSubmitError(r?.message || "Failed to save holding");
    }
  };

  const updateField = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!snapshot) return;
      setEditError("");
      const r = await call
        .post<HoldingSnapshotPostResponse>("/api/snapshots/holding", {
          snapshot_id: snapshot.snapshot_id,
          ...patch,
        })
        .catch(console.error);
      if (r?.status === "success") {
        await fetchSnapshot();
        window.dispatchEvent(
          new CustomEvent("holdings-updated", { detail: { account_id: accountId } }),
        );
      } else {
        setEditError(r?.message || "Failed to update holding");
      }
    },
    [snapshot, fetchSnapshot, accountId],
  );

  const onBlurTicker = async () => {
    const next = editTicker.trim().toUpperCase();
    if (!snapshot || !next) return;
    if (next === (snapshot.ticker_symbol || "").toUpperCase()) return;
    await updateField({ ticker_symbol: next });
  };

  const onBlurQuantity = async () => {
    if (!snapshot) return;
    const parsed = parseFloat(editQuantity);
    if (Number.isNaN(parsed)) {
      setEditError("Quantity must be a number");
      return;
    }
    if (parsed === snapshot.quantity) return;
    await updateField({ quantity: parsed });
  };

  const onBlurCostBasis = async () => {
    if (!snapshot) return;
    if (editCostBasis.trim() === "") {
      if (snapshot.cost_basis == null) return;
      await updateField({ cost_basis: null });
      return;
    }
    const parsed = parseFloat(editCostBasis);
    if (Number.isNaN(parsed)) {
      setEditError("Cost basis must be a number");
      return;
    }
    if (parsed === snapshot.cost_basis) return;
    await updateField({ cost_basis: parsed });
  };

  const onBlurDate = async () => {
    if (!snapshot || !editDate) return;
    if (editDate === toIsoDateInput(snapshot.snapshot_date)) return;
    await updateField({ snapshot_date: editDate });
  };

  const onClickDelete = async () => {
    if (!snapshot) return;
    if (!window.confirm("Remove this holding snapshot?")) return;
    const r = await call
      .delete(`/api/snapshots/holding?id=${snapshot.snapshot_id}`)
      .catch(console.error);
    if (r?.status === "success") {
      window.dispatchEvent(
        new CustomEvent("holdings-updated", { detail: { account_id: accountId } }),
      );
      goBackToAccount();
    } else {
      setEditError(r?.message || "Failed to delete holding");
    }
  };

  if (!accountId) {
    return (
      <div className="HoldingProperties Properties">
        <div className="propertyLabel">Holding</div>
        <div className="property">
          <div className="row keyValue">
            <span className="propertyName">Missing&nbsp;account&nbsp;context</span>
            <span></span>
          </div>
        </div>
      </div>
    );
  }

  if (isNew) {
    return (
      <div className="HoldingProperties Properties">
        <div className="propertyLabel">New&nbsp;Holding</div>
        <form className="property" onSubmit={onSubmitNew}>
          <div className="row keyValue">
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
          </div>
          {tickerMessage && (
            <div className={`row tickerFeedback ${tickerStatus}`}>{tickerMessage}</div>
          )}
          <div className="row keyValue">
            <span className="propertyName">Quantity</span>
            <input
              type="number"
              placeholder="0"
              min="0"
              step="any"
              value={form.quantity}
              onChange={onChangeField("quantity")}
            />
          </div>
          <div className="row keyValue">
            <span className="propertyName">Cost/sh&nbsp;(opt)</span>
            <input
              type="number"
              placeholder="0.00"
              min="0"
              step="any"
              value={form.costBasis}
              onChange={onChangeField("costBasis")}
            />
          </div>
          <div className="row keyValue">
            <span className="propertyName">Snapshot&nbsp;date</span>
            <input
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
            <button type="button" onClick={goBackToAccount}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="HoldingProperties Properties">
        <div className="propertyLabel">Holding</div>
        <div className="property">
          <div className="row keyValue">
            <span className="propertyName">Loading…</span>
            <span></span>
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="HoldingProperties Properties">
        <div className="propertyLabel">Holding</div>
        <div className="property">
          <div className="row formError">{loadError}</div>
        </div>
        <div className="propertyLabel">&nbsp;</div>
        <div className="property">
          <div className="row button">
            <button type="button" onClick={goBackToAccount}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="HoldingProperties Properties">
      <div className="propertyLabel">Holding</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Ticker</span>
          {isReadOnly ? (
            <span>{editTicker || "—"}</span>
          ) : (
            <input
              type="text"
              value={editTicker}
              onChange={(e) => setEditTicker(e.target.value)}
              onBlur={onBlurTicker}
              autoCapitalize="characters"
            />
          )}
        </div>
        {snapshot?.security_name && (
          <div className="row keyValue">
            <span className="propertyName">Name</span>
            <span>{snapshot.security_name}</span>
          </div>
        )}
        <div className="row keyValue">
          <span className="propertyName">Quantity</span>
          {isReadOnly ? (
            <span>{editQuantity || "—"}</span>
          ) : (
            <input
              type="number"
              min="0"
              step="any"
              value={editQuantity}
              onChange={(e) => setEditQuantity(e.target.value)}
              onBlur={onBlurQuantity}
            />
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Cost/sh</span>
          {isReadOnly ? (
            <span>{editCostBasis || "—"}</span>
          ) : (
            <input
              type="number"
              min="0"
              step="any"
              value={editCostBasis}
              onChange={(e) => setEditCostBasis(e.target.value)}
              onBlur={onBlurCostBasis}
            />
          )}
        </div>
        <div className="row keyValue">
          <span className="propertyName">Snapshot&nbsp;date</span>
          {isReadOnly ? (
            <span>{editDate || "—"}</span>
          ) : (
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              onBlur={onBlurDate}
            />
          )}
        </div>
        {editError && <div className="row formError">{editError}</div>}
      </div>
      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        {!isReadOnly && (
          <div className="row button">
            <button type="button" className="delete colored" onClick={onClickDelete}>
              Remove&nbsp;Holding
            </button>
          </div>
        )}
        <div className="row button">
          <button type="button" onClick={goBackToAccount}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
};
