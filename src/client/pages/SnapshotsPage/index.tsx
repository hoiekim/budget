import { FormEventHandler, useMemo, useState } from "react";
import { ViewDate } from "common";
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
  KeyValue,
} from "client";
import { SnapshotPostResponse } from "server";

const toDateInputValue = (d: Date) => d.toISOString().split("T")[0];

const toIsoDateInput = (raw: string | null | undefined): string => {
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : toDateInputValue(date);
};

/** A snapshot belongs on the page when its date falls inside the current view range. */
const isInRange = (isoDate: string, viewDate: ViewDate) => {
  const d = new Date(isoDate);
  return d >= viewDate.getStartDate() && d <= viewDate.getEndDate();
};

interface RowEdit {
  value: string;
  date: string;
  error: string;
}

/**
 * Management surface Hoie requested in the closed PR #600 discussion on #599:
 * rather than auto-picking the "most accurate" account snapshot, let the user
 * see every snapshot in the view range and delete the bad one — e.g. the
 * cash-only `account_balance` snapshot that craters an investment account's
 * balance graph for a month.
 */
const AccountSnapshotsManager = ({ accountId }: { accountId: string }) => {
  const { data, viewDate, setData, router } = useAppContext();
  const { accountSnapshots, accounts } = data;

  const account = accounts.get(accountId);

  const bucket = useMemo(() => {
    const list: AccountSnapshot[] = [];
    accountSnapshots.forEach((snap) => {
      if (snap.account.account_id !== accountId) return;
      if (!isInRange(snap.snapshot.date, viewDate)) return;
      list.push(snap);
    });
    return list.sort((a, b) => (a.snapshot.date < b.snapshot.date ? 1 : -1));
  }, [accountSnapshots, accountId, viewDate]);

  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [addValue, setAddValue] = useState("");
  const [addDate, setAddDate] = useState(toDateInputValue(viewDate.getEndDate()));
  const [addError, setAddError] = useState("");

  const goBack = () => {
    const params = new URLSearchParams();
    params.set("account_id", accountId);
    router.go(PATH.ACCOUNT_DETAIL, { params });
  };

  const setRowError = (id: string, error: string) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], error } }));

  const saveSnapshot = async (snap: AccountSnapshot, edit: RowEdit) => {
    const oldId = snap.snapshot.snapshot_id;
    const numericValue = parseFloat(edit.value);
    if (Number.isNaN(numericValue)) return setRowError(oldId, "Balance must be a number");
    if (!edit.date) return setRowError(oldId, "Date is required");

    const newDate = new Date(edit.date).toISOString();
    const noChange =
      numericValue === snap.account.balances.current &&
      toIsoDateInput(snap.snapshot.date) === edit.date;
    if (noChange) return;

    const newAccount = new Account({
      ...snap.account,
      balances: { ...snap.account.balances, current: numericValue },
    });
    const r = await call
      .post<SnapshotPostResponse>("/api/snapshot", {
        account: newAccount,
        snapshot: { date: newDate },
      })
      .catch(console.error);
    const newId = r?.body?.snapshot_id;
    if (r?.status !== "success" || !newId) {
      return setRowError(oldId, r?.message || "Failed to save snapshot");
    }

    // The account snapshot id is derived from `${account_id}-${date}`, so a
    // date edit lands under a new id — drop the stale row it left behind.
    if (newId !== oldId) await call.delete(`/api/snapshot?id=${oldId}`).catch(console.error);

    setData((oldData) => {
      const newData = new Data(oldData);
      const next = new AccountSnapshotDictionary(newData.accountSnapshots);
      if (newId !== oldId) {
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
  };

  const deleteSnapshot = (snap: AccountSnapshot) => async () => {
    const id = snap.snapshot.snapshot_id;
    const r = await call.delete(`/api/snapshot?id=${id}`).catch(console.error);
    if (r?.status !== "success") return setRowError(id, r?.message || "Failed to delete snapshot");
    setData((oldData) => {
      const newData = new Data(oldData);
      const next = new AccountSnapshotDictionary(newData.accountSnapshots);
      next.delete(id);
      indexedDb.remove(StoreName.accountSnapshots, id).catch(console.error);
      newData.accountSnapshots = next;
      return newData;
    });
  };

  const onSubmitAdd: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setAddError("");
    if (!account) return setAddError("Account context is missing");
    const numericValue = parseFloat(addValue);
    if (Number.isNaN(numericValue)) return setAddError("Balance must be a number");
    if (!addDate) return setAddError("Date is required");

    const newDate = new Date(addDate).toISOString();
    const newAccount = new Account({
      ...account,
      balances: { ...account.balances, current: numericValue },
    });
    const r = await call
      .post<SnapshotPostResponse>("/api/snapshot", {
        account: newAccount,
        snapshot: { date: newDate },
      })
      .catch(console.error);
    const newId = r?.body?.snapshot_id;
    if (r?.status !== "success" || !newId) {
      return setAddError(r?.message || "Failed to add snapshot");
    }
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
          date: toIsoDateInput(snap.snapshot.date),
          error: "",
        };
        const setEdit = (patch: Partial<RowEdit>) =>
          setEdits((prev) => ({ ...prev, [id]: { ...edit, ...patch } }));
        return (
          <Property key={id}>
            <PropertyLabel>Snapshot&nbsp;{idx + 1}</PropertyLabel>
            <KeyValue name="Balance">
              <input
                type="number"
                step="any"
                value={edit.value}
                onChange={(e) => setEdit({ value: e.target.value, error: "" })}
                onBlur={() => saveSnapshot(snap, edit)}
              />
            </KeyValue>
            <KeyValue name="Date">
              <input
                type="date"
                value={edit.date}
                onChange={(e) => setEdit({ date: e.target.value, error: "" })}
                onBlur={() => saveSnapshot(snap, edit)}
              />
            </KeyValue>
            {edit.error && <Row className="formError">{edit.error}</Row>}
            <Row className="button">
              <DeleteButton
                confirmMessage="Delete this account snapshot?"
                onClick={deleteSnapshot(snap)}
              >
                Delete&nbsp;this&nbsp;snapshot
              </DeleteButton>
            </Row>
          </Property>
        );
      })}

      <PropertyLabel>Add&nbsp;Snapshot</PropertyLabel>
      <Property>
        <form onSubmit={onSubmitAdd}>
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
          <Row className="button">
            <button type="submit">Add</button>
          </Row>
        </form>
      </Property>

      <PropertyLabel>&nbsp;</PropertyLabel>
      <Property>
        <Row className="button">
          <button type="button" onClick={goBack}>
            Back
          </button>
        </Row>
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
