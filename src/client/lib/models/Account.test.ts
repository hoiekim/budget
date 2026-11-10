import { describe, expect, it } from "bun:test";
import { AccountSubtype, AccountType } from "common/lib/plaid-enums";
import { accountMatchesTypes } from "./Account";

describe("accountMatchesTypes (#768)", () => {
  it("matches on type", () => {
    expect(
      accountMatchesTypes({ type: AccountType.Investment, subtype: null }, [
        AccountType.Investment,
      ]),
    ).toBe(true);
    expect(
      accountMatchesTypes({ type: AccountType.Investment, subtype: null }, [
        AccountType.Depository,
      ]),
    ).toBe(false);
  });

  it("matches a brokerage through its subtype", () => {
    // Modern Plaid reports a brokerage as type investment, subtype brokerage.
    const brokerage = { type: AccountType.Investment, subtype: AccountSubtype.Brokerage };
    expect(accountMatchesTypes(brokerage, [AccountType.Brokerage])).toBe(true);
    expect(accountMatchesTypes(brokerage, [AccountType.Investment])).toBe(true);
    expect(accountMatchesTypes(brokerage, [AccountType.Depository])).toBe(false);
  });

  it("does not match a subtype that names no type", () => {
    // Checking is a depository subtype, not a type of its own.
    const checking = { type: AccountType.Depository, subtype: AccountSubtype.Checking };
    expect(accountMatchesTypes(checking, [AccountType.Brokerage])).toBe(false);
    expect(accountMatchesTypes(checking, [AccountType.Depository])).toBe(true);
  });

  it("matches loan and other through their subtypes", () => {
    expect(
      accountMatchesTypes({ type: AccountType.Loan, subtype: AccountSubtype.Loan }, [
        AccountType.Loan,
      ]),
    ).toBe(true);
    expect(
      accountMatchesTypes({ type: AccountType.Depository, subtype: AccountSubtype.Other }, [
        AccountType.Other,
      ]),
    ).toBe(true);
  });

  it("matches nothing against an empty selection", () => {
    expect(
      accountMatchesTypes(
        { type: AccountType.Investment, subtype: AccountSubtype.Brokerage },
        [],
      ),
    ).toBe(false);
  });
});
