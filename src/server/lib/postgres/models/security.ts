import {
  JSONSecurity,
  isString,
  isNullableString,
  isNullableNumber,
  isNullableObject,
} from "common";
import {
  SECURITY_ID,
  NAME,
  TICKER_SYMBOL,
  TYPE,
  CLOSE_PRICE,
  CLOSE_PRICE_AS_OF,
  ISO_CURRENCY_CODE,
  ISIN,
  CUSIP,
  RAW,
  UPDATED,
  SECURITIES,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const securitySchema = {
  [SECURITY_ID]: "VARCHAR(255) PRIMARY KEY",
  [NAME]: "VARCHAR(255)",
  [TICKER_SYMBOL]: "VARCHAR(50)",
  [TYPE]: "VARCHAR(50)",
  [CLOSE_PRICE]: "DECIMAL(15, 6)",
  [CLOSE_PRICE_AS_OF]: "DATE",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [ISIN]: "VARCHAR(50)",
  [CUSIP]: "VARCHAR(50)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SecuritySchema = typeof securitySchema;
type SecurityRow = { [k in keyof SecuritySchema]: RowValueType };

export class SecurityModel extends Model<JSONSecurity, SecuritySchema> implements SecurityRow {
  declare security_id: string;
  declare name: string | null;
  declare ticker_symbol: string | null;
  declare type: string | null;
  declare close_price: number | null;
  declare close_price_as_of: string | null;
  declare iso_currency_code: string | null;
  declare isin: string | null;
  declare cusip: string | null;
  declare raw: object | null;
  declare updated: string | null;

  static typeChecker = {
    security_id: isString,
    name: isNullableString,
    ticker_symbol: isNullableString,
    type: isNullableString,
    close_price: isNullableNumber,
    close_price_as_of: isNullableString,
    iso_currency_code: isNullableString,
    isin: isNullableString,
    cusip: isNullableString,
    raw: isNullableObject,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SecurityModel.typeChecker);
  }

  toJSON(): JSONSecurity {
    return {
      security_id: this.security_id,
      name: this.name,
      ticker_symbol: this.ticker_symbol,
      type: this.type,
      close_price: this.close_price,
      close_price_as_of: this.close_price_as_of,
      iso_currency_code: this.iso_currency_code,
      isin: this.isin,
      cusip: this.cusip,
      sedol: null,
      institution_security_id: null,
      institution_id: null,
      proxy_security_id: null,
      is_cash_equivalent: null,
      unofficial_currency_code: null,
      market_identifier_code: null,
      sector: null,
      industry: null,
      option_contract: null,
      fixed_income: null,
    };
  }

  static fromJSON(s: Partial<JSONSecurity>): Partial<SecurityRow> {
    const r: Partial<SecurityRow> = {};
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
  schema: securitySchema,
  ModelClass: SecurityModel,
  supportsSoftDelete: false,
});

export const securityColumns = Object.keys(securitiesTable.schema);
