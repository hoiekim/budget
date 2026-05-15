import { JSONAccount } from "./Account";
import { JSONHolding, JSONSecurity } from "./miscellaneous";

export interface JSONSnapshot {
  snapshot_id: string;
  date: string;
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
