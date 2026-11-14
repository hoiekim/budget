import { describe, expect, test } from "bun:test";
import { parsePlanStatement } from "./parse";

const STATEMENT = [
  "Plan name:,EXAMPLE SAVINGS PLAN",
  "Date Range,01/01/2026 - 09/30/2026",
  "",
  "Date,Investment,Transaction Type,Amount,Shares/Unit",
  '09/30/2026,EXAMPLE INDEX FUND,Contributions,"1,234.56","9.876"',
  '09/30/2026,EXAMPLE INDEX FUND,Advisor Fee,"-12.30","-0.098"',
  "09/15/2026,EXAMPLE TRUST,Transfers,0.00,0.000",
].join("\r\n");

describe("parsePlanStatement", () => {
  test("reads the rows under the header, oldest first, with thousands separators removed", () => {
    const { rows, errors } = parsePlanStatement(STATEMENT);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 7, date: "2026-09-15", investment: "EXAMPLE TRUST", label: "Transfers", amount: 0, shares: 0, shareRounding: 0.0005 },
      { line: 6, date: "2026-09-30", investment: "EXAMPLE INDEX FUND", label: "Advisor Fee", amount: -12.3, shares: -0.098, shareRounding: 0.0005 },
      { line: 5, date: "2026-09-30", investment: "EXAMPLE INDEX FUND", label: "Contributions", amount: 1234.56, shares: 9.876, shareRounding: 0.0005 },
    ]);
  });

  test("reports a row it can't read by line and keeps the rest", () => {
    const text = [
      "Date,Investment,Transaction Type,Amount,Shares/Unit",
      "13/40/2026,EXAMPLE INDEX FUND,Contributions,10,1",
      "09/30/2026,EXAMPLE INDEX FUND,Contributions,abc,1",
      "09/29/2026,EXAMPLE INDEX FUND,Contributions,10,1",
    ].join("\n");
    const { rows, errors } = parsePlanStatement(text);
    expect(errors).toEqual(["Line 2 could not be read.", "Line 3 could not be read."]);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-29"]);
  });

  test("rejects a calendar date that doesn't exist", () => {
    const text = ["Date,Investment,Transaction Type,Amount,Shares/Unit", "02/30/2026,F,Contributions,10,1"].join("\n");
    expect(parsePlanStatement(text).errors).toEqual(["Line 2 could not be read."]);
  });

  test("a file without the header is refused", () => {
    const { rows, errors } = parsePlanStatement("Run Date,Action,Symbol\n01/02/2026,BUY,ABC");
    expect(rows).toEqual([]);
    expect(errors[0]).toContain("header");
  });

  test("records how finely each row gives its shares", () => {
    const text = ["Date,Investment,Transaction Type,Amount,Shares/Unit", "01/05/2026,F,Contributions,10,2.5", "01/06/2026,F,Contributions,10,3"].join("\n");
    expect(parsePlanStatement(text).rows.map((r) => r.shareRounding)).toEqual([0.05, 0.5]);
  });

  test("reads parenthesised negatives and a byte-order mark", () => {
    const text = '﻿Date,Investment,Transaction Type,Amount,Shares/Unit\n01/05/2026,F,Advisor Fee,"(1,000.50)",(2.5)';
    const { rows } = parsePlanStatement(text);
    expect(rows[0].amount).toBe(-1000.5);
    expect(rows[0].shares).toBe(-2.5);
  });
});
