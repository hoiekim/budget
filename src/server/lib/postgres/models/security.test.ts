import { describe, test, expect, mock, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { SecurityModel } = await import("./security");

afterAll(restoreLeaves);

const baseRow = {
  security_id: "sec-1",
  name: "Tether",
  ticker_symbol: "USDT",
  type: "cryptocurrency",
  close_price: 1,
  close_price_as_of: "2026-06-01",
  iso_currency_code: "USD",
  isin: null,
  cusip: null,
  updated: "2026-06-01T00:00:00Z",
};

describe("SecurityModel.toJSON — round-trips raw Plaid fields (regression for #492)", () => {
  test("is_cash_equivalent=true surfaces from raw instead of hardcoded null", () => {
    const model = new SecurityModel({
      ...baseRow,
      raw: { is_cash_equivalent: true },
    });
    expect(model.toJSON().is_cash_equivalent).toBe(true);
  });

  test("is_cash_equivalent=false is preserved (not coerced to null)", () => {
    const model = new SecurityModel({
      ...baseRow,
      raw: { is_cash_equivalent: false },
    });
    expect(model.toJSON().is_cash_equivalent).toBe(false);
  });

  test("missing raw → null, no crash", () => {
    const model = new SecurityModel({ ...baseRow, raw: null });
    expect(model.toJSON().is_cash_equivalent).toBeNull();
  });

  test("raw without the key → null", () => {
    const model = new SecurityModel({ ...baseRow, raw: { sector: "Technology" } });
    expect(model.toJSON().is_cash_equivalent).toBeNull();
  });

  test("other previously-hardcoded fields round-trip from raw", () => {
    const model = new SecurityModel({
      ...baseRow,
      raw: {
        sedol: "B0YQ5W0",
        institution_security_id: "inst-sec-9",
        institution_id: "ins_3",
        proxy_security_id: "prox-1",
        unofficial_currency_code: null,
        market_identifier_code: "XNAS",
        sector: "Technology",
        industry: "Software",
        option_contract: null,
        fixed_income: null,
      },
    });
    const json = model.toJSON();
    expect(json.sedol).toBe("B0YQ5W0");
    expect(json.institution_security_id).toBe("inst-sec-9");
    expect(json.institution_id).toBe("ins_3");
    expect(json.proxy_security_id).toBe("prox-1");
    expect(json.market_identifier_code).toBe("XNAS");
    expect(json.sector).toBe("Technology");
    expect(json.industry).toBe("Software");
  });

  test("column-sourced fields are unaffected", () => {
    const model = new SecurityModel({ ...baseRow, raw: { is_cash_equivalent: true } });
    const json = model.toJSON();
    expect(json.security_id).toBe("sec-1");
    expect(json.ticker_symbol).toBe("USDT");
    expect(json.close_price).toBe(1);
    expect(json.iso_currency_code).toBe("USD");
  });
});
