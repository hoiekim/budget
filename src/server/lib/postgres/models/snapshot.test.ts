import { describe, expect, test } from "bun:test";
import { SnapshotModel } from "./snapshot";

const holdingRow = (cost_basis: number | null) => ({
  snapshot_id: "holding-a-s-20260102",
  user_id: "u",
  snapshot_date: "2026-01-02T00:00:00.000Z",
  snapshot_type: "holding",
  account_id: null,
  balances_available: null,
  balances_current: null,
  balances_limit: null,
  balances_iso_currency_code: null,
  security_id: null,
  close_price: null,
  holding_account_id: "a",
  holding_security_id: "s",
  institution_price: 1,
  institution_value: 100,
  cost_basis,
  quantity: 100,
  updated: null,
  is_deleted: false,
});

describe("SnapshotModel.toHoldingSnapshot", () => {
  test("an unknown cost basis reaches the client as unknown, not as zero", () => {
    expect(new SnapshotModel(holdingRow(null)).toHoldingSnapshot().holding.cost_basis).toBeNull();
    expect(new SnapshotModel(holdingRow(250)).toHoldingSnapshot().holding.cost_basis).toBe(250);
  });
});
