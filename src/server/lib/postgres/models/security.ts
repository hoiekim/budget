import {
  JSONSecurity, isString, isNullableString, isNullableNumber, isNullableDate, isNullableObject,
} from "common";
import {
  SECURITY_ID, NAME, TICKER_SYMBOL, TYPE, CLOSE_PRICE, CLOSE_PRICE_AS_OF,
  ISO_CURRENCY_CODE, ISIN, CUSIP, RAW, UPDATED, SECURITIES,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class SecurityModel extends Model<JSONSecurity> {
  security_id!: string; name!: string | null; ticker_symbol!: string | null; type!: string | null;
  close_price!: number | null; close_price_as_of!: string | null; iso_currency_code!: string | null;
  isin!: string | null; cusip!: string | null; updated!: Date;

  static typeChecker = {
    security_id: isString, name: isNullableString, ticker_symbol: isNullableString, type: isNullableString,
    close_price: isNullableNumber, close_price_as_of: isNullableDate, iso_currency_code: isNullableString,
    isin: isNullableString, cusip: isNullableString, raw: isNullableObject, updated: isNullableDate,
  };

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SecurityModel", SecurityModel.typeChecker);

  constructor(data: unknown) {
    super();
    SecurityModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(SecurityModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
    // Type conversion: DATE column returns as Date object, need ISO string
    this.close_price_as_of = this.close_price_as_of ? (this.close_price_as_of as unknown as Date).toISOString().split("T")[0] : null;
  }

  toJSON(): JSONSecurity {
    return {
      security_id: this.security_id, name: this.name, ticker_symbol: this.ticker_symbol, type: this.type,
      close_price: this.close_price, close_price_as_of: this.close_price_as_of, iso_currency_code: this.iso_currency_code,
      isin: this.isin, cusip: this.cusip, sedol: null, institution_security_id: null, institution_id: null,
      proxy_security_id: null, is_cash_equivalent: null, unofficial_currency_code: null,
      market_identifier_code: null, sector: null, industry: null, option_contract: null, fixed_income: null,
    };
  }

  static toRow(s: Partial<JSONSecurity>): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    if (s.security_id !== undefined) r.security_id = s.security_id;
    if (s.name !== undefined) r.name = s.name;
    if (s.ticker_symbol !== undefined) r.ticker_symbol = s.ticker_symbol;
    if (s.type !== undefined) r.type = s.type;
    if (s.close_price !== undefined) r.close_price = s.close_price;
    if (s.close_price_as_of !== undefined) r.close_price_as_of = s.close_price_as_of;
    if (s.iso_currency_code !== undefined) r.iso_currency_code = s.iso_currency_code;
    if (s.isin !== undefined) r.isin = s.isin;
    if (s.cusip !== undefined) r.cusip = s.cusip;
    r.raw = s;
    return r;
  }
}

export const securitiesTable = createTable({
  name: SECURITIES,
  primaryKey: SECURITY_ID,
  schema: {
    [SECURITY_ID]: "VARCHAR(255) PRIMARY KEY", [NAME]: "VARCHAR(255)", [TICKER_SYMBOL]: "VARCHAR(50)",
    [TYPE]: "VARCHAR(50)", [CLOSE_PRICE]: "DECIMAL(15, 6)", [CLOSE_PRICE_AS_OF]: "DATE",
    [ISO_CURRENCY_CODE]: "VARCHAR(10)", [ISIN]: "VARCHAR(50)", [CUSIP]: "VARCHAR(50)",
    [RAW]: "JSONB", [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: SecurityModel,
});

export const securityColumns = Object.keys(securitiesTable.schema);
