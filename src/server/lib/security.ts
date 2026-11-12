import type { JSONSecurity } from "common";

// The 15 JSONSecurity fields that are unknown (null) for a security created
// without broker-reported metadata. Single-sourced here so a future field
// addition or default change is edited once instead of copy-pasted across
// the eight call sites that used to carry this literal (see #931).
export type BlankSecurityFields = Pick<
  JSONSecurity,
  | "isin"
  | "cusip"
  | "sedol"
  | "institution_security_id"
  | "institution_id"
  | "proxy_security_id"
  | "is_cash_equivalent"
  | "type"
  | "update_datetime"
  | "unofficial_currency_code"
  | "market_identifier_code"
  | "sector"
  | "industry"
  | "option_contract"
  | "fixed_income"
>;

export function blankSecurity(
  overrides: Partial<BlankSecurityFields> = {},
): BlankSecurityFields {
  return {
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
    ...overrides,
  };
}
