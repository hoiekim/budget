import { describe, expect, test } from "bun:test";
import { InvestmentTransactionType } from "plaid";
import { Account } from "../../models/Account";
import {
  AccountDictionary,
  AccountSnapshotDictionary,
  HoldingSnapshotDictionary,
  InvestmentTransactionDictionary,
  TransactionDictionary,
} from "../../models/Data";
import { InvestmentTransaction } from "../../models/InvestmentTransaction";
import { Holding } from "../../models/miscellaneous";
import { HoldingSnapshot, Snapshot } from "../../models/Snapshot";
import { getBalanceData } from "./accounts";
import { isDerivedHoldingSnapshot, withDerivedHoldingSnapshots } from "./derived-holdings";

const TODAY = new Date(2026, 3, 20);

const buy = (id: string, date: string, quantity: number, amount: number, security_id = "sec-1") =>
  new InvestmentTransaction({
    investment_transaction_id: id,
    account_id: "acct-1",
    security_id,
    date,
    quantity,
    amount,
    price: amount / quantity,
    type: InvestmentTransactionType.Buy,
  } as never);

const transactions = (...rows: InvestmentTransaction[]) => {
  const dict = new InvestmentTransactionDictionary();
  for (const row of rows) dict.set(row.investment_transaction_id, row);
  return dict;
};

const enteredSnapshot = (date: string, quantity: number) =>
  new HoldingSnapshot({
    snapshot: new Snapshot({ snapshot_id: `holding-acct-1-sec-1-${date.replaceAll("-", "")}`, date: `${date}T12:00:00.000Z` }),
    holding: new Holding({ account_id: "acct-1", security_id: "sec-1", quantity, cost_basis: null, institution_price: 50 }),
  });

const snapshots = (...rows: HoldingSnapshot[]) => {
  const dict = new HoldingSnapshotDictionary();
  for (const row of rows) dict.set(row.id, row);
  return dict;
};

const derivedOf = (dict: HoldingSnapshotDictionary) => {
  const out: [string, number][] = [];
  dict.forEach((s) => {
    if (isDerivedHoldingSnapshot(s)) out.push([s.snapshot.date.slice(0, 10), s.holding.quantity]);
  });
  return out.sort();
};

describe("withDerivedHoldingSnapshots", () => {
  test("an imported holding gets a position on each movement day and each later month's 1st", () => {
    const result = withDerivedHoldingSnapshots(
      snapshots(),
      transactions(buy(`plan-${"a".repeat(32)}`, "2026-02-10", 10, 500), buy("manual-1", "2026-03-15", 2, 100)),
      TODAY,
    );
    expect(derivedOf(result)).toEqual([
      ["2026-02-10", 10],
      ["2026-03-01", 10],
      ["2026-03-15", 12],
      ["2026-04-01", 12],
    ]);
    const march = Array.from(result.values()).find((s) => s.snapshot.date.startsWith("2026-03-15"))!;
    expect(march.holding).toMatchObject({ account_id: "acct-1", security_id: "sec-1", cost_basis: 600, institution_price: 50 });
  });

  test("a day with an entered snapshot keeps it, and later movements apply on top", () => {
    const stored = snapshots(enteredSnapshot("2026-03-01", 100));
    const result = withDerivedHoldingSnapshots(
      stored,
      transactions(buy(`plan-${"a".repeat(32)}`, "2026-02-10", 10, 500), buy(`plan-${"b".repeat(32)}`, "2026-03-15", 2, 100)),
      TODAY,
    );
    expect(derivedOf(result)).toEqual([
      ["2026-02-10", 10],
      ["2026-03-15", 102],
      ["2026-04-01", 102],
    ]);
    expect(result.get("holding-acct-1-sec-1-20260301")?.holding.quantity).toBe(100);
  });

  test("a holding with no imported rows is left as it is", () => {
    const stored = snapshots(enteredSnapshot("2026-03-01", 100));
    const result = withDerivedHoldingSnapshots(stored, transactions(buy("manual-1", "2026-03-15", 2, 100)), TODAY);
    expect(result).toBe(stored);
  });

  test("only the imported holding is derived, not the account's others", () => {
    const result = withDerivedHoldingSnapshots(
      snapshots(),
      transactions(buy(`plan-${"a".repeat(32)}`, "2026-04-02", 10, 500), buy("manual-1", "2026-04-02", 2, 100, "sec-2")),
      TODAY,
    );
    const securities = new Set(Array.from(result.values()).map((s) => s.holding.security_id));
    expect(securities).toEqual(new Set(["sec-1"]));
  });

  test("a month with an entered snapshot and a derived position counts the holding once", () => {
    const stored = snapshots(enteredSnapshot("2026-03-05", 100));
    const imported = transactions(
      buy(`plan-${"a".repeat(32)}`, "2026-02-10", 10, 500),
      buy(`plan-${"b".repeat(32)}`, "2026-03-15", 2, 100),
    );
    const merged = withDerivedHoldingSnapshots(stored, imported, TODAY);
    const derivedMarch = merged.get("derived-holding-acct-1-sec-1-20260315")!;
    expect(derivedMarch.holding.holding_id).toBe(stored.get("holding-acct-1-sec-1-20260305")!.holding.holding_id);

    const accounts = new AccountDictionary();
    accounts.set("acct-1", new Account({ account_id: "acct-1", type: "investment" } as never));
    const balance = getBalanceData(accounts, new AccountSnapshotDictionary(), merged, new TransactionDictionary(), imported);
    // March holds the latest position, 102 units at 50, not the entered 100 added on top.
    expect(balance.get("acct-1").get(new Date(2026, 2, 15))).toBe(102 * 50);
  });

  test("an unchanged recalculation returns the same dictionary", () => {
    const stored = snapshots();
    const imported = transactions(buy(`plan-${"a".repeat(32)}`, "2026-02-10", 10, 500));
    expect(withDerivedHoldingSnapshots(stored, imported, TODAY)).toBe(withDerivedHoldingSnapshots(stored, imported, TODAY));
  });
});
