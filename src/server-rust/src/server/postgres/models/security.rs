//! `src/server/lib/postgres/models/security.ts`.

use super::base::{Check, Row, Table};
use super::js_object::{nullish_or, prop, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "securities",
    primary_key: "security_id",
    schema: &[
        ("security_id", "VARCHAR(255) PRIMARY KEY"),
        ("name", "VARCHAR(255)"),
        ("ticker_symbol", "VARCHAR(50)"),
        ("type", "VARCHAR(50)"),
        ("close_price", "DECIMAL(15, 6)"),
        ("close_price_as_of", "DATE"),
        ("iso_currency_code", "VARCHAR(10)"),
        ("isin", "VARCHAR(50)"),
        ("cusip", "VARCHAR(50)"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &[],
    indexes: &[],
    model: "SecurityModel",
    checks: &[
        ("security_id", Check::String),
        ("name", Check::NullableString),
        ("ticker_symbol", Check::NullableString),
        ("type", Check::NullableString),
        ("close_price", Check::NullableNumber),
        ("close_price_as_of", Check::NullableString),
        ("iso_currency_code", Check::NullableString),
        ("isin", Check::NullableString),
        ("cusip", Check::NullableString),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `securityColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// The `JSONSecurity` fields with no column of their own, in `toJSON()` order.
const RAW_FIELDS: [&str; 11] = [
    "sedol",
    "institution_security_id",
    "institution_id",
    "proxy_security_id",
    "is_cash_equivalent",
    "unofficial_currency_code",
    "market_identifier_code",
    "sector",
    "industry",
    "option_contract",
    "fixed_income",
];

/// `toJSON()`: a `JSONSecurity`.
///
/// Fields without a dedicated column are round-tripped through `raw` (the
/// `JSONSecurity` stored by `from_json`). Reading them back instead of
/// hardcoding null preserves Plaid signals both sides rely on, notably
/// `is_cash_equivalent`, which feeds the cash-holding detectors.
pub fn to_json(row: &Row) -> Json {
    // `this.raw ?? {}`: a row with no `raw` has none of the fields.
    let raw = row.get("raw");
    let columns = Literal::new()
        .opt("security_id", row.get("security_id"))
        .opt("name", row.get("name"))
        .opt("ticker_symbol", row.get("ticker_symbol"))
        .opt("type", row.get("type"))
        .opt("close_price", row.get("close_price"))
        .opt("close_price_as_of", row.get("close_price_as_of"))
        .opt("iso_currency_code", row.get("iso_currency_code"))
        .opt("isin", row.get("isin"))
        .opt("cusip", row.get("cusip"));
    RAW_FIELDS.iter().fold(columns, |json, field| json.set(field, nullish_or(prop(raw, field), Json::Null))).into()
}

/// `fromJSON()`: the columns a (partial) `JSONSecurity` sets; `raw` keeps
/// the whole of what was given.
pub fn from_json(s: &Obj) -> QueryData {
    Literal::new()
        .opt("security_id", s.get("security_id"))
        .opt("name", s.get("name"))
        .opt("ticker_symbol", s.get("ticker_symbol"))
        .opt("type", s.get("type"))
        .opt("close_price", s.get("close_price"))
        .opt("close_price_as_of", s.get("close_price_as_of"))
        .opt("iso_currency_code", s.get("iso_currency_code"))
        .opt("isin", s.get("isin"))
        .opt("cusip", s.get("cusip"))
        .set("raw", s.clone())
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    // The row of `security.test.ts`, with the `raw` each case gives it.
    fn row_with(raw: Json) -> Row {
        let row = obj(json!({
            "security_id": "sec-1",
            "name": "Tether",
            "ticker_symbol": "USDT",
            "type": "cryptocurrency",
            "close_price": 1,
            "close_price_as_of": "2026-06-01",
            "iso_currency_code": "USD",
            "isin": null,
            "cusip": null,
            "raw": raw,
            "updated": "2026-06-01T00:00:00Z",
        }));
        TABLE.validate(row).unwrap()
    }

    // `security.test.ts`, "SecurityModel.toJSON — round-trips raw Plaid fields".

    #[test]
    fn is_cash_equivalent_true_surfaces_from_raw_instead_of_hardcoded_null() {
        assert_eq!(to_json(&row_with(json!({ "is_cash_equivalent": true })))["is_cash_equivalent"], json!(true));
    }

    #[test]
    fn is_cash_equivalent_false_is_preserved_not_coerced_to_null() {
        assert_eq!(to_json(&row_with(json!({ "is_cash_equivalent": false })))["is_cash_equivalent"], json!(false));
    }

    #[test]
    fn missing_raw_is_null_no_crash() {
        assert_eq!(to_json(&row_with(Json::Null)).get("is_cash_equivalent"), Some(&Json::Null));
    }

    #[test]
    fn raw_without_the_key_is_null() {
        assert_eq!(to_json(&row_with(json!({ "sector": "Technology" }))).get("is_cash_equivalent"), Some(&Json::Null));
    }

    #[test]
    fn other_previously_hardcoded_fields_round_trip_from_raw() {
        let json = to_json(&row_with(json!({
            "sedol": "B0YQ5W0",
            "institution_security_id": "inst-sec-9",
            "institution_id": "ins_3",
            "proxy_security_id": "prox-1",
            "unofficial_currency_code": null,
            "market_identifier_code": "XNAS",
            "sector": "Technology",
            "industry": "Software",
            "option_contract": null,
            "fixed_income": null,
        })));
        assert_eq!(json["sedol"], json!("B0YQ5W0"));
        assert_eq!(json["institution_security_id"], json!("inst-sec-9"));
        assert_eq!(json["institution_id"], json!("ins_3"));
        assert_eq!(json["proxy_security_id"], json!("prox-1"));
        assert_eq!(json["market_identifier_code"], json!("XNAS"));
        assert_eq!(json["sector"], json!("Technology"));
        assert_eq!(json["industry"], json!("Software"));
    }

    #[test]
    fn column_sourced_fields_are_unaffected() {
        let json = to_json(&row_with(json!({ "is_cash_equivalent": true })));
        assert_eq!(json["security_id"], json!("sec-1"));
        assert_eq!(json["ticker_symbol"], json!("USDT"));
        assert_eq!(json["close_price"], json!(1));
        assert_eq!(json["iso_currency_code"], json!("USD"));
    }

    #[test]
    fn to_json_has_every_field_in_order_whatever_raw_holds() {
        // `raw` shadows nothing a column holds, and a `raw` that is no object has no fields at all.
        for raw in [json!({ "name": "from raw", "close_price": 99, "sector": "Technology", "fixed_income": { "yield_rate": null } }), json!([])] {
            let has_fields = raw.is_object();
            assert_json(
                &to_json(&row_with(raw)),
                json!({
                    "security_id": "sec-1",
                    "name": "Tether",
                    "ticker_symbol": "USDT",
                    "type": "cryptocurrency",
                    "close_price": 1,
                    "close_price_as_of": "2026-06-01",
                    "iso_currency_code": "USD",
                    "isin": null,
                    "cusip": null,
                    "sedol": null,
                    "institution_security_id": null,
                    "institution_id": null,
                    "proxy_security_id": null,
                    "is_cash_equivalent": null,
                    "unofficial_currency_code": null,
                    "market_identifier_code": null,
                    "sector": if has_fields { json!("Technology") } else { Json::Null },
                    "industry": null,
                    "option_contract": null,
                    "fixed_income": if has_fields { json!({ "yield_rate": null }) } else { Json::Null },
                }),
            );
        }
    }

    #[test]
    fn from_json_keeps_the_whole_security_as_raw() {
        let security = obj(json!({
            "security_id": "sec-voo",
            "name": "Vanguard S&P 500 ETF",
            "ticker_symbol": "VOO",
            "type": "etf",
            "close_price": 512.345678,
            "close_price_as_of": "2026-06-01",
            "iso_currency_code": "USD",
            "isin": null,
            "cusip": "922908363",
            "is_cash_equivalent": false,
            "sector": "Miscellaneous",
        }));
        assert_row(
            &from_json(&security),
            json!({
                "security_id": "sec-voo",
                "name": "Vanguard S&P 500 ETF",
                "ticker_symbol": "VOO",
                "type": "etf",
                "close_price": 512.345678,
                "close_price_as_of": "2026-06-01",
                "iso_currency_code": "USD",
                "isin": null,
                "cusip": "922908363",
                "raw": {
                    "security_id": "sec-voo",
                    "name": "Vanguard S&P 500 ETF",
                    "ticker_symbol": "VOO",
                    "type": "etf",
                    "close_price": 512.345678,
                    "close_price_as_of": "2026-06-01",
                    "iso_currency_code": "USD",
                    "isin": null,
                    "cusip": "922908363",
                    "is_cash_equivalent": false,
                    "sector": "Miscellaneous",
                },
            }),
        );
    }

    #[test]
    fn from_json_writes_null_but_not_undefined() {
        let partial = obj(json!({ "security_id": "sec-voo", "close_price": null }));
        assert_row(
            &from_json(&partial),
            json!({ "security_id": "sec-voo", "close_price": null, "raw": { "security_id": "sec-voo", "close_price": null } }),
        );
    }
}
