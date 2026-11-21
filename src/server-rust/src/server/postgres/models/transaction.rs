//! `src/server/lib/postgres/models/transaction.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{nullish_or, or, prop, rest, truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "transactions",
    primary_key: "transaction_id",
    schema: &[
        ("transaction_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("account_id", "VARCHAR(255) NOT NULL"),
        ("name", "TEXT"),
        ("merchant_name", "TEXT"),
        ("amount", "DECIMAL(15, 2)"),
        ("iso_currency_code", "VARCHAR(10)"),
        ("date", "DATE NOT NULL"),
        ("pending", "BOOLEAN DEFAULT FALSE"),
        ("pending_transaction_id", "VARCHAR(255)"),
        ("payment_channel", "TEXT"),
        ("location_country", "TEXT"),
        ("location_region", "TEXT"),
        ("location_city", "TEXT"),
        ("label_budget_id", "UUID"),
        ("label_category_id", "UUID"),
        ("label_memo", "TEXT"),
        ("label_category_confidence", "FLOAT"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
        // Origin marker. `plaid` for anything synced from Plaid or simple-fin
        // (safe default so the auto-migration backfills existing rows without
        // a script). `manual` for rows the user created via
        // `GET /api/new-transaction` on a manual account: those rows
        // are safe from Plaid overwrite because Plaid uses distinct id shapes,
        // but the column keeps the intent auditable and future-proofs a CSV
        // import path.
        ("source", "VARCHAR(20) NOT NULL DEFAULT 'plaid'"),
    ],
    constraints: &[],
    indexes: &[
        IndexDefinition::column("account_id"),
        IndexDefinition::column("date"),
        IndexDefinition::column("pending"),
        // Delta-by-cursor warm sync filters `WHERE user_id = ? AND updated >= ?` on
        // every app load. Without a leading-`updated` composite the planner
        // seq-scans the user's whole table; this keeps the read O(rows-changed).
        // Also the only `user_id` index this table needs: a `user_id`-only lookup is a
        // leftmost-prefix scan of this composite.
        IndexDefinition::columns(&["user_id", "updated"]),
        // A cold sync streams the user's whole table in primary-key batches.
        IndexDefinition::columns(&["user_id", "transaction_id"]),
    ],
    model: "TransactionModel",
    checks: &[
        ("transaction_id", Check::String),
        ("user_id", Check::String),
        ("account_id", Check::String),
        ("name", Check::NullableString),
        ("merchant_name", Check::NullableString),
        ("amount", Check::NullableNumber),
        ("iso_currency_code", Check::NullableString),
        ("date", Check::String),
        ("pending", Check::NullableBoolean),
        ("pending_transaction_id", Check::NullableString),
        ("payment_channel", Check::NullableString),
        ("location_country", Check::NullableString),
        ("location_region", Check::NullableString),
        ("location_city", Check::NullableString),
        ("label_budget_id", Check::NullableString),
        ("label_category_id", Check::NullableString),
        ("label_memo", Check::NullableString),
        ("label_category_confidence", Check::NullableNumber),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
        ("source", Check::NullableString),
    ],
    supports_soft_delete: true,
};

/// `transactionColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONTransaction`. What Plaid's shape has and no column
/// holds is `null`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("transaction_id", row.get("transaction_id"))
        .opt("account_id", row.get("account_id"))
        .opt("name", row.get("name"))
        .opt("merchant_name", row.get("merchant_name"))
        .opt("amount", row.get("amount"))
        .opt("iso_currency_code", row.get("iso_currency_code"))
        .opt("date", row.get("date"))
        .opt("pending", row.get("pending"))
        .opt("pending_transaction_id", row.get("pending_transaction_id"))
        .opt("payment_channel", row.get("payment_channel"))
        .set(
            "label",
            Literal::new()
                .opt("budget_id", row.get("label_budget_id"))
                .opt("category_id", row.get("label_category_id"))
                .opt("memo", row.get("label_memo"))
                .opt("category_confidence", row.get("label_category_confidence")),
        )
        .set(
            "location",
            Literal::new()
                .set("address", Json::Null)
                .opt("city", row.get("location_city"))
                .opt("region", row.get("location_region"))
                .set("postal_code", Json::Null)
                .opt("country", row.get("location_country"))
                .set("store_number", Json::Null)
                .set("lat", Json::Null)
                .set("lon", Json::Null),
        )
        .set(
            "payment_meta",
            Literal::new()
                .set("reference_number", Json::Null)
                .set("ppd_id", Json::Null)
                .set("payee", Json::Null)
                .set("by_order_of", Json::Null)
                .set("payer", Json::Null)
                .set("payment_method", Json::Null)
                .set("payment_processor", Json::Null)
                .set("reason", Json::Null),
        )
        .set("category_id", Json::Null)
        .set("category", Json::Null)
        .set("account_owner", Json::Null)
        .set("unofficial_currency_code", Json::Null)
        .set("authorized_date", Json::Null)
        .set("authorized_datetime", Json::Null)
        .set("datetime", Json::Null)
        .set("transaction_code", Json::Null)
        .set("is_deleted", nullish_or(row.get("is_deleted"), false))
        .set("source", nullish_or(row.get("source"), "plaid"))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONTransaction` sets. The date is
/// the day the purchase was authorized where Plaid knows it, else the day it
/// posted. `raw` takes what is left of the transaction without the label and
/// the origin marker.
pub fn from_json(tx: &Obj, user_id: &str) -> QueryData {
    let location = truthy_only(tx.get("location"));
    let label = truthy_only(tx.get("label"));
    Literal::new()
        .set("user_id", user_id)
        .opt("transaction_id", tx.get("transaction_id"))
        .opt("account_id", tx.get("account_id"))
        .opt("name", tx.get("name"))
        .opt("merchant_name", tx.get("merchant_name"))
        .opt("amount", tx.get("amount"))
        .opt("iso_currency_code", tx.get("iso_currency_code"))
        .opt("date", or(tx.get("authorized_date"), tx.get("date")))
        .opt("pending", tx.get("pending"))
        .opt("pending_transaction_id", tx.get("pending_transaction_id"))
        .opt("payment_channel", tx.get("payment_channel"))
        .opt("location_country", prop(location, "country"))
        .opt("location_region", prop(location, "region"))
        .opt("location_city", prop(location, "city"))
        .opt("label_budget_id", prop(label, "budget_id"))
        .opt("label_category_id", prop(label, "category_id"))
        .opt("label_memo", prop(label, "memo"))
        .opt("label_category_confidence", prop(label, "category_confidence"))
        .opt("source", tx.get("source"))
        .set("raw", rest(tx, &["label", "source"]))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "transaction_id": "tx-1",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "account_id": "acc-checking",
            "name": "SQ *BLUE BOTTLE COFFEE",
            "merchant_name": "Blue Bottle Coffee",
            "amount": 6.25,
            "iso_currency_code": "USD",
            "date": "2026-05-15",
            "pending": false,
            "pending_transaction_id": null,
            "payment_channel": "in store",
            "location_country": "US",
            "location_region": "CA",
            "location_city": null,
            "label_budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "label_category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
            "label_memo": null,
            "label_category_confidence": 0.42,
            "raw": { "transaction_id": "tx-1", "category": ["Food and Drink"] },
            "updated": "2026-05-16T00:00:00.000Z",
            "is_deleted": false,
            "source": "plaid",
        })
    }

    #[test]
    fn to_json_fills_the_plaid_shape_around_the_columns() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "transaction_id": "tx-1",
                "account_id": "acc-checking",
                "name": "SQ *BLUE BOTTLE COFFEE",
                "merchant_name": "Blue Bottle Coffee",
                "amount": 6.25,
                "iso_currency_code": "USD",
                "date": "2026-05-15",
                "pending": false,
                "pending_transaction_id": null,
                "payment_channel": "in store",
                "label": {
                    "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                    "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                    "memo": null,
                    "category_confidence": 0.42,
                },
                "location": {
                    "address": null,
                    "city": null,
                    "region": "CA",
                    "postal_code": null,
                    "country": "US",
                    "store_number": null,
                    "lat": null,
                    "lon": null,
                },
                "payment_meta": {
                    "reference_number": null,
                    "ppd_id": null,
                    "payee": null,
                    "by_order_of": null,
                    "payer": null,
                    "payment_method": null,
                    "payment_processor": null,
                    "reason": null,
                },
                "category_id": null,
                "category": null,
                "account_owner": null,
                "unofficial_currency_code": null,
                "authorized_date": null,
                "authorized_datetime": null,
                "datetime": null,
                "transaction_code": null,
                "is_deleted": false,
                "source": "plaid",
            }),
        );
    }

    #[test]
    fn to_json_defaults_a_null_tombstone_flag_and_origin_only() {
        let mut row = obj(row());
        row.insert("is_deleted".into(), Json::Null);
        row.insert("source".into(), Json::Null);
        row.insert("pending".into(), Json::Null);
        row.insert("amount".into(), Json::Null);
        let json = to_json(&row);
        assert_eq!(json["is_deleted"], json!(false));
        assert_eq!(json["source"], json!("plaid"));
        assert_eq!(json.get("pending"), Some(&Json::Null));
        assert_eq!(json.get("amount"), Some(&Json::Null));

        row.insert("is_deleted".into(), json!(true));
        row.insert("source".into(), json!("manual"));
        let json = to_json(&row);
        assert_eq!(json["is_deleted"], json!(true));
        assert_eq!(json["source"], json!("manual"));
    }

    #[test]
    fn from_json_flattens_and_keeps_provider_data_as_raw() {
        let tx = obj(json!({
            "transaction_id": "tx-1",
            "account_id": "acc-checking",
            "name": "SQ *BLUE BOTTLE COFFEE",
            "merchant_name": "Blue Bottle Coffee",
            "amount": 6.25,
            "iso_currency_code": "USD",
            "date": "2026-05-16",
            "authorized_date": "2026-05-15",
            "pending": false,
            "pending_transaction_id": null,
            "payment_channel": "in store",
            "location": { "address": null, "city": "Oakland", "region": "CA", "postal_code": null, "country": "US" },
            "label": { "budget_id": null, "category_id": null, "category_confidence": 0 },
            "source": "plaid",
        }));
        assert_row(
            &from_json(&tx, "user-1"),
            json!({
                "user_id": "user-1",
                "transaction_id": "tx-1",
                "account_id": "acc-checking",
                "name": "SQ *BLUE BOTTLE COFFEE",
                "merchant_name": "Blue Bottle Coffee",
                "amount": 6.25,
                "iso_currency_code": "USD",
                "date": "2026-05-15",
                "pending": false,
                "pending_transaction_id": null,
                "payment_channel": "in store",
                "location_country": "US",
                "location_region": "CA",
                "location_city": "Oakland",
                "label_budget_id": null,
                "label_category_id": null,
                "label_category_confidence": 0,
                "source": "plaid",
                "raw": {
                    "transaction_id": "tx-1",
                    "account_id": "acc-checking",
                    "name": "SQ *BLUE BOTTLE COFFEE",
                    "merchant_name": "Blue Bottle Coffee",
                    "amount": 6.25,
                    "iso_currency_code": "USD",
                    "date": "2026-05-16",
                    "authorized_date": "2026-05-15",
                    "pending": false,
                    "pending_transaction_id": null,
                    "payment_channel": "in store",
                    "location": { "address": null, "city": "Oakland", "region": "CA", "postal_code": null, "country": "US" },
                },
            }),
        );
    }

    #[test]
    fn from_json_takes_the_posted_date_when_none_was_authorized() {
        let date_of = |tx: Json| from_json(&obj(tx), "user-1").get("date").cloned();
        assert_eq!(date_of(json!({ "authorized_date": null, "date": "2026-05-16" })), Some(json!("2026-05-16")));
        assert_eq!(date_of(json!({ "authorized_date": "", "date": "2026-05-16" })), Some(json!("2026-05-16")));
        assert_eq!(date_of(json!({ "date": "2026-05-16" })), Some(json!("2026-05-16")));
        assert_eq!(date_of(json!({ "authorized_date": "2026-05-15" })), Some(json!("2026-05-15")));
        // Neither: `date` is whatever the posted date is, null when it is null and unset when it is undefined.
        assert_eq!(date_of(json!({ "authorized_date": null, "date": null })), Some(Json::Null));
        assert_eq!(date_of(json!({ "authorized_date": null })), None);
        assert_eq!(date_of(json!({})), None);
    }

    #[test]
    fn from_json_leaves_columns_alone_without_their_object() {
        let partial = obj(json!({ "transaction_id": "tx-1", "merchant_name": null, "location": null, "label": { "memo": "lunch" } }));
        assert_row(
            &from_json(&partial, "user-1"),
            json!({
                "user_id": "user-1",
                "transaction_id": "tx-1",
                "merchant_name": null,
                "label_memo": "lunch",
                "raw": { "transaction_id": "tx-1", "merchant_name": null, "location": null },
            }),
        );
    }
}
