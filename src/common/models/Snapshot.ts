import { assign, getRandomId } from "common";
import { Account } from "./Account";
import { Holding, Security } from "./miscellaneous";

export class Snapshot {
  get id() {
    return this.snapshot_id;
  }

  snapshot_id: string = getRandomId();
  date: string = new Date().toISOString();

  constructor(init?: Partial<Snapshot>) {
    assign(this, init);
  }
}

export class AccountSnapshot {
  snapshot = new Snapshot();
  user = { user_id: getRandomId() };
  account = new Account();

  constructor(init?: Partial<AccountSnapshot>) {
    assign(this, init);
    if (init?.snapshot) this.snapshot = new Snapshot(init.snapshot);
    if (init?.account) this.account = new Account(init.account);
  }
}

export class HoldingSnapshot {
  snapshot = new Snapshot();
  user = { user_id: getRandomId() };
  holding = new Holding();

  constructor(init?: Partial<HoldingSnapshot>) {
    assign(this, init);
    if (init?.snapshot) this.snapshot = new Snapshot(init.snapshot);
    if (init?.holding) this.holding = new Holding(init.holding);
  }
}

export class SecuritySnapshot {
  snapshot = new Snapshot();
  security = new Security();

  constructor(init?: Partial<SecuritySnapshot>) {
    assign(this, init);
    if (init?.snapshot) this.snapshot = new Snapshot(init.snapshot);
    if (init?.security) this.security = new Security(init.security);
  }
}

export type SnapshotData = AccountSnapshot | HoldingSnapshot | SecuritySnapshot;
