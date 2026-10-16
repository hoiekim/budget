import { describe, test, expect } from "bun:test";
import { Transaction } from "client";
import { detectRecurringBills, normalizeMerchantName } from "./recurring";

const tx = (
  id: string,
  date: string,
  amount: number,
  name = "Netflix",
  extra: Partial<Transaction> = {},
): Transaction =>
  new Transaction({
    transaction_id: id,
    account_id: "acc1",
    name,
    merchant_name: name,
    date: `${date}T00:00:00`,
    amount,
    iso_currency_code: "USD",
    ...extra,
  });

// Pin "now" so the recency check is deterministic.
const NOW = new Date("2026-10-15T12:00:00");

describe("normalizeMerchantName", () => {
  test("groups Plaid name variants", () => {
    expect(normalizeMerchantName("NETFLIX.COM 8665795717")).toBe("netflix");
    expect(normalizeMerchantName("Netflix")).toBe("netflix");
    expect(normalizeMerchantName("Netflix, Inc.")).toBe("netflix inc");
  });
  test("keeps short digit tokens, drops long ones", () => {
    expect(normalizeMerchantName("7-Eleven")).toBe("7 eleven");
    expect(normalizeMerchantName("Shell 88421093")).toBe("shell");
  });
  test("empty input stays empty", () => {
    expect(normalizeMerchantName("")).toBe("");
  });
});

describe("detectRecurringBills", () => {
  test("detects a monthly bill", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-07-15", 15.99),
        tx("t2", "2026-08-15", 15.99),
        tx("t3", "2026-09-15", 15.99),
        tx("t4", "2026-10-15", 15.99),
      ],
      NOW,
    );
    expect(bills.length).toBe(1);
    const bill = bills[0]!;
    expect(bill.merchant).toBe("Netflix");
    expect(bill.cadence).toBe("monthly");
    expect(bill.amount).toBe(15.99);
    expect(bill.occurrences).toBe(4);
    expect(bill.lastDate).toBe("2026-10-15");
    expect(bill.nextExpectedDate).toBe("2026-11-15");
    expect(bill.transactionIds).toEqual(["t1", "t2", "t3", "t4"]);
  });

  test("detects a weekly bill and tolerates small interval drift", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-09-24", 4.99, "Spotify"),
        tx("t2", "2026-10-01", 4.99, "Spotify"),
        // one day late — within the weekly ±2d tolerance
        tx("t3", "2026-10-09", 4.99, "Spotify"),
      ],
      NOW,
    );
    expect(bills.length).toBe(1);
    expect(bills[0]!.cadence).toBe("weekly");
    expect(bills[0]!.nextExpectedDate).toBe("2026-10-16");
  });

  test("groups merchant name variants into one bill", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-07-15", 15.99, "Netflix"),
        tx("t2", "2026-08-15", 15.99, "NETFLIX.COM"),
        tx("t3", "2026-09-15", 15.99, "Netflix 8665795717"),
        tx("t4", "2026-10-15", 15.99, "NETFLIX.COM"),
      ],
      NOW,
    );
    expect(bills.length).toBe(1);
    // Most common raw variant wins the display name.
    expect(bills[0]!.merchant).toBe("NETFLIX.COM");
    expect(bills[0]!.occurrences).toBe(4);
  });

  test("tolerates utility-style amount variance within ±25% of median", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-07-10", 80, "PG&E"),
        tx("t2", "2026-08-10", 95, "PG&E"),
        tx("t3", "2026-09-10", 88, "PG&E"),
        tx("t4", "2026-10-10", 92, "PG&E"),
      ],
      NOW,
    );
    expect(bills.length).toBe(1);
    // Median of [80, 88, 92, 95] = 90.
    expect(bills[0]!.amount).toBe(90);
  });

  test("rejects groups with fewer than 3 occurrences", () => {
    const bills = detectRecurringBills(
      [tx("t1", "2026-09-15", 15.99), tx("t2", "2026-10-15", 15.99)],
      NOW,
    );
    expect(bills.length).toBe(0);
  });

  test("rejects irregular intervals", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-07-01", 15.99),
        tx("t2", "2026-07-20", 15.99),
        tx("t3", "2026-09-15", 15.99),
        tx("t4", "2026-10-15", 15.99),
      ],
      NOW,
    );
    expect(bills.length).toBe(0);
  });

  test("rejects unstable amounts", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-07-15", 15.99),
        tx("t2", "2026-08-15", 15.99),
        // 2× the median — outside the ±25% band.
        tx("t3", "2026-09-15", 31.98),
        tx("t4", "2026-10-15", 15.99),
      ],
      NOW,
    );
    expect(bills.length).toBe(0);
  });

  test("excludes lapsed bills (last charge older than 2× cadence)", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-04-15", 15.99),
        tx("t2", "2026-05-15", 15.99),
        tx("t3", "2026-06-15", 15.99),
        // 3 months before NOW — older than 2× the ~30d monthly cadence.
        tx("t4", "2026-07-15", 15.99),
      ],
      NOW,
    );
    expect(bills.length).toBe(0);
  });

  test("keeps a yearly bill charged 11 months ago", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2023-11-20", 99.99, "Prime"),
        tx("t2", "2024-11-20", 99.99, "Prime"),
        tx("t3", "2025-11-20", 99.99, "Prime"),
      ],
      NOW,
    );
    expect(bills.length).toBe(1);
    expect(bills[0]!.cadence).toBe("yearly");
    expect(bills[0]!.nextExpectedDate).toBe("2026-11-20");
  });

  test("ignores pending, zero-amount, and inflow rows", () => {
    const bills = detectRecurringBills(
      [
        tx("t1", "2026-08-15", 15.99),
        tx("t2", "2026-09-15", 15.99),
        // Pending third occurrence must not complete the trio…
        tx("t3", "2026-10-15", 15.99, "Netflix", { pending: true }),
        // …nor must a zero-amount or inflow row.
        tx("t4", "2026-10-15", 0),
        tx("t5", "2026-10-15", -15.99),
      ],
      NOW,
    );
    expect(bills.length).toBe(0);
  });

  test("sorts by next expected date", () => {
    const bills = detectRecurringBills(
      [
        tx("m1", "2026-08-15", 15.99, "Netflix"),
        tx("m2", "2026-09-15", 15.99, "Netflix"),
        tx("m3", "2026-10-15", 15.99, "Netflix"),
        tx("w1", "2026-10-01", 4.99, "Spotify"),
        tx("w2", "2026-10-08", 4.99, "Spotify"),
        tx("w3", "2026-10-15", 4.99, "Spotify"),
      ],
      NOW,
    );
    expect(bills.length).toBe(2);
    // Spotify (weekly, next 10-22) comes before Netflix (monthly, next 11-15).
    expect(bills[0]!.merchant).toBe("Spotify");
    expect(bills[1]!.merchant).toBe("Netflix");
  });
});
