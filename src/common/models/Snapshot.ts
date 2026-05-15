import { assign, getRandomId } from "../utils";
import { JSONAccount } from "./Account";
import { JSONHolding, JSONSecurity } from "./miscellaneous";

export interface JSONSnapshot {
  snapshot_id: string;
  date: string;
}

/**
 * Model class for the inner `{snapshot_id, date}` part of a JSONSnapshotData.
 * Lets callers `new Snapshot({snapshot_id, date})` without restating the
 * empty-string / now defaults each time. The outer wrappers (AccountSnapshot,
 * HoldingSnapshot, SecuritySnapshot) live in `client/lib/models/Snapshot.ts`
 * because they compose with client-only model classes (Account, Holding,
 * Security); this inner class is pure-data and shared.
 */
export class Snapshot implements JSONSnapshot {
  get id() {
    return this.snapshot_id;
  }

  snapshot_id: string = getRandomId();
  date: string = new Date().toISOString();

  constructor(init?: Partial<Snapshot>) {
    assign(this, init);
  }
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
