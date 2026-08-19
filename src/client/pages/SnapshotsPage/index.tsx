import { Fragment, useMemo, useRef, useState } from "react";
import { getDateString, LocalDate } from "common";
import {
  call,
  PATH,
  useAppContext,
  Data,
  indexedDb,
  StoreName,
  Account,
  AccountSnapshot,
  AccountSnapshotDictionary,
  Snapshot,
  DeleteButton,
  Properties,
  PropertyLabel,
  Property,
  Row,
  ButtonRow,
  KeyValue,
} from "client";
import { SnapshotPostResponse } from "server";
import {
  dateInputValue,
  isDayInRange,
  hasDateCollision,
  dateFromSnapshotId,
  failureMessage,
  dropRowState,
} from "./lib";

/**
 * The day a row occupies, taken from its id — the snapshot's identity — with the
 * stored timestamp only as a fallback for an id that is not the expected shape.
 */
const rowDate = (snap: AccountSnapshot): string =>
  dateFromSnapshotId(snap.snapshot.snapshot_id) ?? dateInputValue(snap.snapshot.date);

/**
 * Only the fields the user types. Errors live in a separate map keyed by the
 * same id — folding them in here meant a `setRowError` on a row the user never
 * touched stored `{ error }` with no `value`/`date`, and the render's `??`
 * fallback (nullish only) let that win and flipped both inputs from controlled
 * to uncontrolled.
 */
interface RowEdit {
  value: string;
  date: string;
}

/**
 * Management surface for the per-account snapshot list: rather than auto-
 * picking the "most accurate" account snapshot, let the user see every
 * snapshot in the view range and delete the bad one — e.g. the cash-only
 * `account_balance` snapshot that craters an investment account's balance
 * graph for a month.
 */
const AccountSnapshotsManager = ({ accountId }: { accountId: string }) => {
  const { data, viewDate, setData } = useAppContext();
  const { accountSnapshots, accounts } = data;

  const account = accounts.get(accountId);

  // Every snapshot for this account (id + date), for one-per-day collision
  // checks — not scoped to the view range, since a date edit can move a
  // snapshot onto a day outside the current window.
  const accountSnaps = useMemo(() => {
    const all: string[] = [];
    accountSnapshots.forEach((snap) => {
      if (snap.account.account_id === accountId) all.push(snap.snapshot.snapshot_id);
    });
    return all;
  }, [accountSnapshots, accountId]);

  const rangeEnd = getDateString(viewDate.getEndDate());

  const bucket = useMemo(() => {
    const start = viewDate.getStartDate();
    const end = viewDate.getEndDate();
    const list: AccountSnapshot[] = [];
    accountSnapshots.forEach((snap) => {
      if (snap.account.account_id !== accountId) return;
      if (!isDayInRange(rowDate(snap), start, end)) return;
      list.push(snap);
    });
    return list.sort((a, b) => (rowDate(a) < rowDate(b) ? 1 : -1));
  }, [accountSnapshots, accountId, viewDate]);

  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [addValue, setAddValue] = useState("");
  const [addDate, setAddDate] = useState(rangeEnd);
  const [addError, setAddError] = useState("");

  // The header's period steppers are global and `setViewDate` navigates to the
  // SAME path with new params, so this page re-renders without remounting. A
  // once-at-mount seed would leave the Add form defaulting into a month that is
  // no longer on screen — and adding from it would file a snapshot the list then
  // filters out, which reads as a silent failure. Re-default on a period change
  // while keeping a date the user typed within the period. Render-phase reset
  // rather than a ref guard: budget renders a concurrent root under
  // StrictMode, where a ref survives an abandoned render but a queued update
  // does not.
  const [prevRangeEnd, setPrevRangeEnd] = useState(rangeEnd);
  if (prevRangeEnd !== rangeEnd) {
    setPrevRangeEnd(rangeEnd);
    setAddDate(rangeEnd);
    setAddError("");
  }
  const saving = useRef<Set<string>>(new Set());

  const setRowError = (id: string, error: string) =>
    setRowErrors((prev) => ({ ...prev, [id]: error }));

  /**
   * Drop a row's typed-in state once its write has landed, so the row
   * re-derives from the snapshot.
   *
   * `keepIfChanged` is the edit object the write was built from. A save is
   * async, so the user can type into the row while it is in flight; `setEdit`
   * always stores a fresh object, so a reference mismatch means "touched since
   * the request went out" and that entry is left alone rather than reverted out
   * from under them.
   */
  const clearRowState = (ids: string[], keepIfChanged?: RowEdit) => {
    setEdits((prev) => dropRowState(prev, ids, keepIfChanged));
    // Errors take no guard: `setEdit` blanks the row's error on every keystroke,
    // so after a successful write any surviving error is stale by definition.
    setRowErrors((prev) => dropRowState(prev, ids));
  };

  const saveSnapshot = async (snap: AccountSnapshot, edit: RowEdit) => {
    const oldId = snap.snapshot.snapshot_id;
    const originalValue = String(snap.account.balances.current ?? "");
    // Compare against the day the id encodes, not a browser-local render of the
    // stored timestamp. Those disagree whenever the browser and server sit in
    // different zones, and reading `dateChanged` as false on a row whose
    // displayed day already differs from its id would skip the collision guard
    // below and silently re-date the snapshot on a balance-only edit.
    const dateChanged = rowDate(snap) !== edit.date;
    // No-op check first, so blurring an untouched row (incl. a null balance
    // rendered as "") never trips the numeric validation below.
    if (edit.value === originalValue && !dateChanged) return;

    const numericValue = parseFloat(edit.value);
    if (Number.isNaN(numericValue)) return setRowError(oldId, "Balance must be a number");
    if (!edit.date) return setRowError(oldId, "Date is required");
    if (dateChanged && hasDateCollision(accountSnaps, accountId, edit.date, oldId)) {
      return setRowError(oldId, "A snapshot already exists on that date");
    }
    if (saving.current.has(oldId)) return;
    saving.current.add(oldId);

    try {
      const newAccount = new Account({
        ...snap.account,
        balances: { ...snap.account.balances, current: numericValue },
      });
      // Bare `YYYY-MM-DD` — the server's `LocalDate` reads it as local
      // midnight, so the derived `${account_id}-${YYYYMMDD}` id lands on the
      // day the user picked (an ISO string would shift it a day in PST).
      const r = await call
        .post<SnapshotPostResponse>("/api/snapshot", {
          account: newAccount,
          snapshot: { date: edit.date },
        })
        .catch(console.error);
      const newId = r?.body?.snapshot_id;
      if (r?.status !== "success" || !newId) {
        return setRowError(oldId, failureMessage(r, "Failed to save snapshot"));
      }
      // Cache the date the SERVER stored, not a browser-local re-derivation of
      // the same input — otherwise the optimistic row disagrees with the next
      // sync whenever the browser and the server sit in different zones.
      const newDate = r.body?.date ?? new LocalDate(edit.date).toISOString();

      // A date edit lands under a new id — only evict the stale row once the
      // server confirms its deletion, so a failed DELETE can't desync the
      // cache from the server (which would resurrect it on the next sync).
      let oldDeleted = false;
      if (newId !== oldId) {
        const dr = await call.delete(`/api/snapshot?id=${oldId}`).catch(console.error);
        oldDeleted = dr?.status === "success";
      }

      // Drop this row's typed-in state once it is persisted, under BOTH ids.
      // The edit map is keyed by snapshot_id, which is derived from the date, so
      // a date edit moves the row to a new key and leaves the old entry behind.
      // Move the row back later and that stale entry is picked up again — the
      // row then renders the abandoned date while the server holds the real one,
      // and the next focus/blur saves the stale value, moving the snapshot with
      // no user edit at all. Clearing both makes the row re-derive from the
      // snapshot, which is the only state that survived the round trip.
      // Only guard the in-flight edit when the id is unchanged. If the row moved
      // to `newId`, the key it renders under changed too, so preserving the entry
      // under `oldId` would strand it exactly the way the abandoned entries above
      // were stranded — and re-create the bug this clearing exists to fix.
      clearRowState([oldId, newId], newId === oldId ? edit : undefined);
      if (newId !== oldId && !oldDeleted) {
        setRowError(newId, "Saved, but failed to remove the old-date snapshot");
      }

      setData((oldData) => {
        const newData = new Data(oldData);
        const next = new AccountSnapshotDictionary(newData.accountSnapshots);
        if (newId !== oldId && oldDeleted) {
          next.delete(oldId);
          indexedDb.remove(StoreName.accountSnapshots, oldId).catch(console.error);
        }
        const newSnapshot = new AccountSnapshot({
          snapshot: new Snapshot({ snapshot_id: newId, date: newDate }),
          account: newAccount,
        });
        next.set(newId, newSnapshot);
        indexedDb.save(newSnapshot).catch(console.error);
        newData.accountSnapshots = next;
        return newData;
      });
    } finally {
      saving.current.delete(oldId);
    }
  };

  const deleteSnapshot = (snap: AccountSnapshot) => async () => {
    const id = snap.snapshot.snapshot_id;
    const r = await call.delete(`/api/snapshot?id=${id}`).catch(console.error);
    if (r?.status !== "success")
      return setRowError(id, failureMessage(r, "Failed to delete snapshot"));
    setData((oldData) => {
      const newData = new Data(oldData);
      const next = new AccountSnapshotDictionary(newData.accountSnapshots);
      next.delete(id);
      indexedDb.remove(StoreName.accountSnapshots, id).catch(console.error);
      newData.accountSnapshots = next;
      return newData;
    });
    // Ids are one-per-day, so re-adding this same day reuses this exact key.
    // Leaving the entry behind would render the deleted row's typed value, date
    // and error on the new row, and its first blur would re-date the snapshot.
    clearRowState([id]);
  };

  const onSubmitAdd = async () => {
    setAddError("");
    if (!account) return setAddError("Account context is missing");
    const numericValue = parseFloat(addValue);
    if (Number.isNaN(numericValue)) return setAddError("Balance must be a number");
    if (!addDate) return setAddError("Date is required");
    if (hasDateCollision(accountSnaps, accountId, addDate, "")) {
      return setAddError("A snapshot already exists on that date");
    }

    const newAccount = new Account({
      ...account,
      balances: { ...account.balances, current: numericValue },
    });
    const r = await call
      .post<SnapshotPostResponse>("/api/snapshot", {
        account: newAccount,
        snapshot: { date: addDate },
      })
      .catch(console.error);
    const newId = r?.body?.snapshot_id;
    if (r?.status !== "success" || !newId) {
      return setAddError(failureMessage(r, "Failed to add snapshot"));
    }
    const newDate = r.body?.date ?? new LocalDate(addDate).toISOString();
    setData((oldData) => {
      const newData = new Data(oldData);
      const next = new AccountSnapshotDictionary(newData.accountSnapshots);
      const newSnapshot = new AccountSnapshot({
        snapshot: new Snapshot({ snapshot_id: newId, date: newDate }),
        account: newAccount,
      });
      next.set(newId, newSnapshot);
      indexedDb.save(newSnapshot).catch(console.error);
      newData.accountSnapshots = next;
      return newData;
    });
    // Same reuse hazard as the delete path: this id may carry state left over
    // from a row that previously occupied this day, so the freshly added row
    // must start from the snapshot rather than inherit it.
    clearRowState([newId]);
    setAddValue("");
  };

  return (
    <Properties className="SnapshotsPage">
      <PropertyLabel>Account&nbsp;Snapshots</PropertyLabel>
      <Property>
        <KeyValue name="Account">
          <span>{account?.custom_name || account?.name || accountId}</span>
        </KeyValue>
      </Property>

      {bucket.length === 0 && (
        <Property>
          <KeyValue name="No&nbsp;snapshots&nbsp;in&nbsp;this&nbsp;range">
            <span></span>
          </KeyValue>
        </Property>
      )}

      {bucket.map((snap, idx) => {
        const id = snap.snapshot.snapshot_id;
        const edit = edits[id] ?? {
          value: String(snap.account.balances.current ?? ""),
          date: rowDate(snap),
        };
        const error = rowErrors[id] ?? "";
        const setEdit = (patch: Partial<RowEdit>) => {
          setEdits((prev) => ({ ...prev, [id]: { ...edit, ...patch } }));
          setRowError(id, "");
        };
        // Fragment keeps each per-snapshot <PropertyLabel> + <Property> pair as
        // DIRECT children of <Properties> so the `div.Properties > .propertyLabel`
        // / `> .property` direct-child styling applies (no wrapper div).
        return (
          <Fragment key={id}>
            <PropertyLabel>Snapshot&nbsp;{idx + 1}</PropertyLabel>
            <Property>
              <KeyValue name="Balance">
                <input
                  type="number"
                  step="any"
                  value={edit.value}
                  onChange={(e) => setEdit({ value: e.target.value })}
                  onBlur={() => saveSnapshot(snap, edit)}
                />
              </KeyValue>
              <KeyValue name="Date">
                <input
                  type="date"
                  value={edit.date}
                  onChange={(e) => setEdit({ date: e.target.value })}
                  onBlur={() => saveSnapshot(snap, edit)}
                />
              </KeyValue>
              {error && <Row className="formError">{error}</Row>}
              <Row className="button">
                <DeleteButton
                  confirmMessage="Delete this account snapshot?"
                  onClick={deleteSnapshot(snap)}
                >
                  Delete&nbsp;this&nbsp;snapshot
                </DeleteButton>
              </Row>
            </Property>
          </Fragment>
        );
      })}

      <PropertyLabel>Add&nbsp;Snapshot</PropertyLabel>
      {/* No <form> wrapper: it would sit between div.property and every
          div.row, and the Properties styling is direct-child
          (`div.Properties > div.property > div.row`), so this whole section
          would lose its row padding, key/value spread and input alignment. */}
      <Property>
        <KeyValue name="Balance">
          <input
            type="number"
            step="any"
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="0"
          />
        </KeyValue>
        <KeyValue name="Date">
          <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} />
        </KeyValue>
        {addError && <Row className="formError">{addError}</Row>}
        <ButtonRow onClick={onSubmitAdd}>Add</ButtonRow>
      </Property>
    </Properties>
  );
};

export const SnapshotsPage = () => {
  const { router } = useAppContext();
  const params = router.getActiveParams(PATH.SNAPSHOTS);
  const accountId = params.get("account_id") || "";

  return (
    <div className="SnapshotsPage">
      {accountId ? (
        <AccountSnapshotsManager accountId={accountId} />
      ) : (
        <Properties className="SnapshotsPage">
          <PropertyLabel>Snapshots</PropertyLabel>
          <Property>
            <KeyValue name="Missing&nbsp;account&nbsp;context">
              <span></span>
            </KeyValue>
          </Property>
        </Properties>
      )}
    </div>
  );
};
