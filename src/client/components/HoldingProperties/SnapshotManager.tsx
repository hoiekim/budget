import { Fragment, useCallback, useEffect, useState } from "react";
import {
  call,
  useAppContext,
  useMutate,
  Data,
  Snapshot,
  Holding,
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  DeleteButton,
  PropertyLabel,
  Property,
  Row,
  KeyValue,
  indexedDb,
  isDerivedHoldingSnapshot,
} from "client";
import { HoldingSnapshotPostResponse } from "server";

const toDateInputValue = (d: Date) => d.toISOString().split("T")[0];

const toIsoDateInput = (raw: string | null | undefined): string => {
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : toDateInputValue(date);
};

interface SnapshotManagerProps {
  snapshots: HoldingSnapshot[];
  isCash: boolean;
  isReadOnly: boolean;
  currencySymbol: string;
  /** Called when the last underlying snapshot is deleted and the bucket is empty. */
  onEmpty: () => void;
}

/**
 * The per-snapshot editable sections of the holding detail page: one
 * PropertyLabel + Property pair per underlying snapshot, with the edit
 * state and the snapshot CRUD (update on blur, delete) that backs them.
 * Extracted from HoldingProperties so the detail page stays composition —
 * the bucket derivation still lives in the parent and arrives as props.
 */
export const SnapshotManager = ({
  snapshots,
  isCash,
  isReadOnly,
  currencySymbol,
  onEmpty,
}: SnapshotManagerProps) => {
  const { setData } = useAppContext();
  const holdingSnapshotMutate = useMutate(HoldingSnapshot);

  // Per-snapshot edit state — keyed by snapshot_id. We track input values
  // separately from the snapshot data so edits stay isolated per row.
  const [snapEdits, setSnapEdits] = useState<
    Record<string, { quantity: string; costBasis: string; date: string; error: string }>
  >({});

  useEffect(() => {
    setSnapEdits((prev) => {
      const next: typeof prev = {};
      snapshots.forEach((snap) => {
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
  }, [snapshots]);

  /** Patch a single underlying snapshot (per-snapshot two-row section). */
  const updateSnapshot = useCallback(
    async (snap: HoldingSnapshot, patch: Record<string, unknown>) => {
      // A derived position exists only in memory, so an edit saves it as a
      // position the user entered, with every figure it showed.
      const body = isDerivedHoldingSnapshot(snap)
        ? {
            account_id: snap.holding.account_id,
            security_id: snap.holding.security_id,
            quantity: snap.holding.quantity,
            cost_basis: snap.holding.cost_basis ?? undefined,
            institution_price: snap.holding.institution_price,
            institution_value: snap.holding.institution_value,
            snapshot_date: snap.snapshot.date.slice(0, 10),
            ...patch,
          }
        : { snapshot_id: snap.snapshot.snapshot_id, ...patch };
      const r = await call.post<HoldingSnapshotPostResponse>("/api/snapshots/holding", body).catch(console.error);
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
    const removedId = snap.snapshot.snapshot_id;
    try {
      await holdingSnapshotMutate.delete(removedId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete holding";
      setSnapEdits((prev) => ({
        ...prev,
        [removedId]: { ...prev[removedId], error: message },
      }));
      return;
    }
    // If we just deleted the last underlying snapshot, the bucket is empty
    // and there's nothing more to render — go back.
    if (snapshots.length <= 1) onEmpty();
  };

  return (
    <>
      {snapshots.map((snap, idx) => {
        const id = snap.snapshot.snapshot_id;
        const edit = snapEdits[id] ?? {
          quantity: "",
          costBasis: "",
          date: "",
          error: "",
        };
        const setEdit = (patch: Partial<typeof edit>) =>
          setSnapEdits((prev) => ({ ...prev, [id]: { ...edit, ...patch } }));
        // <Fragment> keeps the per-snapshot <PropertyLabel> + <Property> pair
        // as DIRECT children of <Properties> — a wrapper div would break the
        // grid layout because <Properties>'s styles depend on the direct-child
        // pairing.
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
              <KeyValue name={isCash ? "Amount" : "Quantity"}>
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
              </KeyValue>
              {!isCash && (
                <KeyValue name="Cost&nbsp;basis">
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
                </KeyValue>
              )}
              <KeyValue name="Snapshot&nbsp;date">
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
              </KeyValue>
              {edit.error && <Row className="formError">{edit.error}</Row>}
              {!isReadOnly && !isDerivedHoldingSnapshot(snap) && (
                <Row className="button">
                  <DeleteButton
                    confirmMessage="Remove this holding snapshot?"
                    onClick={onClickDeleteSnap(snap)}
                  >
                    Remove&nbsp;this&nbsp;snapshot
                  </DeleteButton>
                </Row>
              )}
            </Property>
          </Fragment>
        );
      })}
    </>
  );
};
