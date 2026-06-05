import { JSONAccount } from "./Account";
import { JSONHolding, JSONSecurity } from "./miscellaneous";

export interface JSONSnapshot {
  snapshot_id: string;
  date: string;
  /** Tombstone flag. When true, the row was soft-deleted on the server
   *  and the client should EVICT this snapshot_id from its local cache
   *  (in-memory dict + IDB) on receipt. Only ever set when the caller
   *  asked for `includeDeleted` on `/api/snapshots`. */
  is_deleted?: boolean;
}

export interface JSONAccountSnapshot {
  snapshot: JSONSnapshot;
  user: { user_id: string };
  account: JSONAccount;
}

export interface JSONHoldingSnapshot {
  snapshot: JSONSnapshot;
  user: { user_id: string };
  holding: JSONHolding;
}

export interface JSONSecuritySnapshot {
  snapshot: JSONSnapshot;
  security: JSONSecurity;
}

export type JSONSnapshotData = JSONAccountSnapshot | JSONHoldingSnapshot | JSONSecuritySnapshot;
