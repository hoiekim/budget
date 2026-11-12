import { describe, expect, it } from "bun:test";
import { blankSecurity } from "./security";

describe("blankSecurity", () => {
  it("returns all 15 fields as null by default", () => {
    expect(blankSecurity()).toEqual({
      isin: null,
      cusip: null,
      sedol: null,
      institution_security_id: null,
      institution_id: null,
      proxy_security_id: null,
      is_cash_equivalent: null,
      type: null,
      update_datetime: null,
      unofficial_currency_code: null,
      market_identifier_code: null,
      sector: null,
      industry: null,
      option_contract: null,
      fixed_income: null,
    });
  });

  it("applies overrides over the null defaults", () => {
    expect(
      blankSecurity({ type: "cash", is_cash_equivalent: true }),
    ).toEqual({
      ...blankSecurity(),
      type: "cash",
      is_cash_equivalent: true,
    });
  });

  it("returns a fresh object on every call", () => {
    expect(blankSecurity()).not.toBe(blankSecurity());
  });
});
