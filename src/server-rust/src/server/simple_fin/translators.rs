//! SimpleFin accounts, transactions and holdings in the app's (Plaid-shaped)
//! models: `src/server/lib/simple-fin/translators.ts`.
//!
//! The SimpleFin payload is read as JSON: a field that is missing stays
//! missing (`undefined`) in what is built from it, and a number field that
//! does not hold a number becomes `null` (`NaN`), as in the TypeScript.

use serde_json::json;

use crate::common::date::{get_date_string, get_date_time_string_of};
use crate::js::{num, to_js_string, to_number, truthy, Json, JsDate, Obj};

/// JavaScript's unary plus: the number a value converts to.
pub fn unary_plus(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => to_number(text),
        Some(Json::Array(items)) if items.len() <= 1 => to_number(&to_js_string(&Json::Array(items.clone()))),
        Some(_) => f64::NAN,
    }
}

/// Inserts `value` under `key` unless it is `undefined`.
fn put(object: &mut Obj, key: &str, value: Option<&Json>) {
    if let Some(value) = value {
        object.insert(key.to_string(), value.clone());
    }
}

/// `object.<key>` where reading it from `null` or `undefined` throws.
fn field<'a>(object: Option<&'a Json>, key: &str, of: &str) -> anyhow::Result<Option<&'a Json>> {
    match object {
        None | Some(Json::Null) => anyhow::bail!("undefined is not an object (evaluating '{of}.{key}')"),
        Some(Json::Object(map)) => Ok(map.get(key)),
        Some(_) => Ok(None),
    }
}

/// `text.toLowerCase().includes(word)`; anything but a string throws.
fn lower_includes(value: Option<&Json>, word: &str, of: &str) -> anyhow::Result<bool> {
    match value {
        Some(Json::String(text)) => Ok(text.to_lowercase().contains(word)),
        _ => anyhow::bail!("{of}.toLowerCase is not a function"),
    }
}

/// `list.length > 0`; reading it from `null` or `undefined` throws.
fn has_length(value: Option<&Json>, of: &str) -> anyhow::Result<bool> {
    match value {
        None | Some(Json::Null) => anyhow::bail!("undefined is not an object (evaluating '{of}.length')"),
        Some(Json::Array(items)) => Ok(!items.is_empty()),
        Some(Json::String(text)) => Ok(!text.is_empty()),
        Some(_) => Ok(false),
    }
}

/// `getDateTimeString(new Date(seconds * 1000))`.
fn date_time_of_seconds(seconds: Option<&Json>) -> String {
    get_date_time_string_of(JsDate::from_ms(unary_plus(seconds) * 1000.0))
}

/// The account and its institution.
pub struct TranslatedAccount {
    pub institution: Json,
    pub account: Json,
}

/// The account of a SimpleFin account, with its institution. It is an
/// investment account when it holds anything or when its name or its
/// institution's says so. `item_id`, `institution_id` and the user's settings
/// are assigned by the sync, not here.
pub fn translate_account(simple_fin_account: &Json, _item: &Json) -> anyhow::Result<TranslatedAccount> {
    let account = Some(simple_fin_account);
    let org = field(account, "org", "simpleFinAccount")?;
    let name = field(account, "name", "simpleFinAccount")?;
    let currency = field(account, "currency", "simpleFinAccount")?;

    let mut balances = Obj::new();
    balances.insert("available".into(), num(unary_plus(field(account, "available-balance", "simpleFinAccount")?)));
    balances.insert("current".into(), num(unary_plus(field(account, "balance", "simpleFinAccount")?)));
    balances.insert("limit".into(), Json::Null);
    put(&mut balances, "iso_currency_code", currency);
    put(&mut balances, "unofficial_currency_code", currency);

    let mut institution = Obj::new();
    put(&mut institution, "institution_id", field(org, "id", "org")?);
    put(&mut institution, "name", field(org, "name", "org")?);
    put(&mut institution, "url", field(org, "url", "org")?);
    institution.insert("products".into(), json!([]));
    institution.insert("country_codes".into(), json!([]));
    institution.insert("routing_numbers".into(), json!([]));
    institution.insert("oauth".into(), json!(false));

    let is_investment = has_length(field(account, "holdings", "simpleFinAccount")?, "holdings")?
        || lower_includes(name, "investment", "name")?
        || lower_includes(field(org, "name", "org")?, "investment", "org.name")?;

    let mut translated = Obj::new();
    put(&mut translated, "account_id", field(account, "id", "simpleFinAccount")?);
    put(&mut translated, "name", name);
    translated.insert("balances".into(), Json::Object(balances));
    translated.insert("type".into(), json!(if is_investment { "investment" } else { "other" }));
    translated.insert("mask".into(), Json::Null);
    translated.insert("official_name".into(), Json::Null);
    translated.insert("subtype".into(), Json::Null);

    Ok(TranslatedAccount { institution: Json::Object(institution), account: Json::Object(translated) })
}

/// A transaction of a SimpleFin account; its memo is kept in the label.
pub fn translate_transaction(simple_fin_transaction: &Json, simple_fin_account: &Json) -> anyhow::Result<Json> {
    let transaction = Some(simple_fin_transaction);
    let posted = date_time_of_seconds(field(transaction, "posted", "simpleFinTransaction")?);
    let transacted_at = date_time_of_seconds(field(transaction, "transacted_at", "simpleFinTransaction")?);

    let mut label = Obj::new();
    put(&mut label, "memo", field(transaction, "memo", "simpleFinTransaction")?);

    let mut translated = Obj::new();
    put(&mut translated, "transaction_id", field(transaction, "id", "simpleFinTransaction")?);
    translated.insert("date".into(), json!(posted));
    translated.insert("datetime".into(), json!(posted));
    translated.insert("amount".into(), num(unary_plus(field(transaction, "amount", "simpleFinTransaction")?)));
    put(&mut translated, "name", field(transaction, "description", "simpleFinTransaction")?);
    put(&mut translated, "account_id", field(Some(simple_fin_account), "id", "simpleFinAccount")?);
    put(&mut translated, "merchant_name", field(transaction, "payee", "simpleFinTransaction")?);
    translated.insert("authorized_date".into(), json!(transacted_at));
    translated.insert("authorized_datetime".into(), json!(transacted_at));
    translated.insert("label".into(), Json::Object(label));
    translated.insert("pending_transaction_id".into(), Json::Null);
    translated.insert("category_id".into(), Json::Null);
    translated.insert("category".into(), Json::Null);
    translated.insert(
        "location".into(),
        json!({
            "address": null,
            "city": null,
            "region": null,
            "postal_code": null,
            "country": null,
            "lat": null,
            "lon": null,
            "store_number": null,
        }),
    );
    translated.insert(
        "payment_meta".into(),
        json!({
            "ppd_id": null,
            "by_order_of": null,
            "payee": null,
            "payer": null,
            "payment_method": null,
            "payment_processor": null,
            "reason": null,
            "reference_number": null,
        }),
    );
    translated.insert("account_owner".into(), Json::Null);
    translated.insert("iso_currency_code".into(), Json::Null);
    translated.insert("unofficial_currency_code".into(), Json::Null);
    translated.insert("pending".into(), json!(false));
    translated.insert("payment_channel".into(), json!("other"));
    translated.insert("transaction_code".into(), Json::Null);
    Ok(Json::Object(translated))
}

/// A transaction of a SimpleFin account that holds securities, as a purchase
/// of one unit at its amount.
pub fn translate_investment_transaction(simple_fin_transaction: &Json, simple_fin_account: &Json) -> anyhow::Result<Json> {
    let transaction = Some(simple_fin_transaction);
    let amount = num(unary_plus(field(transaction, "amount", "simpleFinTransaction")?));

    let mut translated = Obj::new();
    put(&mut translated, "investment_transaction_id", field(transaction, "id", "simpleFinTransaction")?);
    translated.insert("date".into(), json!(date_time_of_seconds(field(transaction, "posted", "simpleFinTransaction")?)));
    translated.insert("amount".into(), amount.clone());
    translated.insert("quantity".into(), json!(1));
    translated.insert("price".into(), amount);
    put(&mut translated, "name", field(transaction, "description", "simpleFinTransaction")?);
    put(&mut translated, "account_id", field(Some(simple_fin_account), "id", "simpleFinAccount")?);
    translated.insert("security_id".into(), Json::Null);
    translated.insert("cancel_transaction_id".into(), Json::Null);
    translated.insert("type".into(), json!("buy"));
    translated.insert("subtype".into(), json!("buy"));
    translated.insert("fees".into(), Json::Null);
    translated.insert("iso_currency_code".into(), Json::Null);
    translated.insert("unofficial_currency_code".into(), Json::Null);
    translated.insert("label".into(), json!({}));
    Ok(Json::Object(translated))
}

/// The holding and its security.
pub struct TranslatedHolding {
    pub security: Json,
    pub holding: Json,
}

/// A holding of a SimpleFin account, and a security for it with a new id. The
/// price is the market value per share, as of the day the holding was created.
pub fn translate_holding(simple_fin_holding: &Json, simple_fin_account: &Json) -> anyhow::Result<TranslatedHolding> {
    let holding = Some(simple_fin_holding);
    let currency = field(holding, "currency", "simpleFinHolding")?;
    let market_value = unary_plus(field(holding, "market_value", "simpleFinHolding")?);
    let shares = unary_plus(field(holding, "shares", "simpleFinHolding")?);

    let date = JsDate::from_ms(unary_plus(field(holding, "created", "simpleFinHolding")?) * 1000.0);
    let close_price_as_of = get_date_string(date);
    let close_price = num(market_value / shares);
    let iso_currency_code = match currency {
        Some(currency) if truthy(currency) => Some(currency),
        _ => field(Some(simple_fin_account), "currency", "simpleFinAccount")?,
    };

    let security_id = uuid::Uuid::new_v4().to_string();
    let mut security = Obj::new();
    security.insert("security_id".into(), json!(security_id));
    put(&mut security, "ticker_symbol", field(holding, "symbol", "simpleFinHolding")?);
    put(&mut security, "name", field(holding, "description", "simpleFinHolding")?);
    put(&mut security, "iso_currency_code", iso_currency_code);
    security.insert("close_price".into(), close_price.clone());
    security.insert("close_price_as_of".into(), json!(close_price_as_of));
    for key in [
        "isin",
        "cusip",
        "sedol",
        "institution_security_id",
        "institution_id",
        "proxy_security_id",
        "is_cash_equivalent",
        "type",
        "update_datetime",
        "unofficial_currency_code",
        "market_identifier_code",
        "sector",
        "industry",
        "option_contract",
        "fixed_income",
    ] {
        security.insert(key.into(), Json::Null);
    }

    let mut translated = Obj::new();
    put(&mut translated, "account_id", field(Some(simple_fin_account), "id", "simpleFinAccount")?);
    translated.insert("security_id".into(), json!(security_id));
    put(&mut translated, "holding_id", field(holding, "id", "simpleFinHolding")?);
    translated.insert("institution_price".into(), close_price);
    translated.insert("institution_price_as_of".into(), json!(close_price_as_of));
    translated.insert("institution_value".into(), num(market_value));
    translated.insert("cost_basis".into(), num(unary_plus(field(holding, "cost_basis", "simpleFinHolding")?)));
    translated.insert("quantity".into(), num(shares));
    put(&mut translated, "iso_currency_code", iso_currency_code);
    translated.insert("unofficial_currency_code".into(), Json::Null);

    Ok(TranslatedHolding { security: Json::Object(security), holding: Json::Object(translated) })
}

#[cfg(test)]
mod tests {
    use super::*;

    // `translators.test.ts`.

    fn org() -> Json {
        json!({
            "id": "org-123",
            "domain": "bank.example.com",
            "name": "Example Bank",
            "sfin-url": "https://sfin.bank.example.com",
            "url": "https://bank.example.com",
        })
    }

    fn item() -> Json {
        json!({ "item_id": "item-456", "institution_id": "inst-789", "access_token": "access-token-123" })
    }

    fn account_with(overrides: Json) -> Json {
        let mut account = json!({
            "id": "acc-001",
            "org": org(),
            "name": "Checking Account",
            "currency": "USD",
            "balance": "1500.50",
            "available-balance": "1400.25",
            "balance-date": 1704067200,
            "transactions": [],
            "holdings": [],
        });
        for (key, value) in overrides.as_object().unwrap() {
            account[key] = value.clone();
        }
        account
    }

    fn transaction_with(overrides: Json) -> Json {
        let mut transaction = json!({
            "id": "txn-001",
            "posted": 1704153600,
            "amount": "-50.00",
            "description": "Coffee Shop",
            "payee": "Local Coffee",
            "memo": "Morning coffee",
            "transacted_at": 1704150000,
        });
        for (key, value) in overrides.as_object().unwrap() {
            transaction[key] = value.clone();
        }
        transaction
    }

    fn holding_with(overrides: Json) -> Json {
        let mut holding = json!({
            "id": "hold-001",
            "created": 1704067200,
            "currency": "USD",
            "cost_basis": "1000.00",
            "description": "Apple Inc.",
            "market_value": "1200.00",
            "purchase_price": "100.00",
            "shares": "10",
            "symbol": "AAPL",
        });
        for (key, value) in overrides.as_object().unwrap() {
            holding[key] = value.clone();
        }
        holding
    }

    #[test]
    fn translates_a_basic_checking_account() {
        let TranslatedAccount { institution, account } = translate_account(&account_with(json!({})), &item()).unwrap();
        assert_eq!(
            institution,
            json!({
                "institution_id": "org-123",
                "name": "Example Bank",
                "url": "https://bank.example.com",
                "products": [],
                "country_codes": [],
                "routing_numbers": [],
                "oauth": false,
            })
        );
        assert_eq!(account["account_id"], json!("acc-001"));
        assert_eq!(account["name"], json!("Checking Account"));
        assert_eq!(account["balances"]["current"], json!(1500.5));
        assert_eq!(account["balances"]["available"], json!(1400.25));
        assert_eq!(account["balances"]["iso_currency_code"], json!("USD"));
        assert_eq!(account["type"], json!("other"));
        assert_eq!(account["mask"], Json::Null);
        assert_eq!(account["official_name"], Json::Null);
        assert_eq!(account["subtype"], Json::Null);
    }

    #[test]
    fn identifies_an_investment_account_by_holdings_or_by_name() {
        let by_holdings = account_with(json!({ "holdings": [holding_with(json!({}))] }));
        assert_eq!(translate_account(&by_holdings, &item()).unwrap().account["type"], json!("investment"));
        let by_name = account_with(json!({ "name": "My Investment Portfolio" }));
        assert_eq!(translate_account(&by_name, &item()).unwrap().account["type"], json!("investment"));
        let mut by_org = org();
        by_org["name"] = json!("Global Investment Services");
        let by_org = account_with(json!({ "org": by_org }));
        assert_eq!(translate_account(&by_org, &item()).unwrap().account["type"], json!("investment"));
    }

    #[test]
    fn an_account_without_holdings_or_an_organization_fails() {
        let mut account = account_with(json!({}));
        account.as_object_mut().unwrap().remove("holdings");
        assert!(translate_account(&account, &item()).is_err());
        assert!(translate_account(&account_with(json!({ "org": null })), &item()).is_err());
    }

    #[test]
    fn translates_a_transaction() {
        let transaction = translate_transaction(&transaction_with(json!({})), &account_with(json!({}))).unwrap();
        assert_eq!(transaction["transaction_id"], json!("txn-001"));
        assert_eq!(transaction["amount"], json!(-50));
        assert_eq!(transaction["name"], json!("Coffee Shop"));
        assert_eq!(transaction["merchant_name"], json!("Local Coffee"));
        assert_eq!(transaction["account_id"], json!("acc-001"));
        assert_eq!(transaction["pending"], json!(false));
        assert_eq!(transaction["label"], json!({ "memo": "Morning coffee" }));
        assert_eq!(transaction["payment_channel"], json!("other"));
        let posted = get_date_time_string_of(JsDate::from_ms(1704153600.0 * 1000.0));
        assert_eq!(transaction["date"], json!(posted));
        assert_eq!(transaction["datetime"], json!(posted));
        let transacted = get_date_time_string_of(JsDate::from_ms(1704150000.0 * 1000.0));
        assert_eq!(transaction["authorized_date"], json!(transacted));
        assert!(transaction["date"].as_str().unwrap().ends_with("T00:00:00"));
        assert_eq!(transaction["location"]["store_number"], Json::Null);
    }

    #[test]
    fn a_positive_amount_and_unreadable_fields_translate_as_javascript_does() {
        let positive = translate_transaction(&transaction_with(json!({ "amount": "100.00" })), &account_with(json!({}))).unwrap();
        assert_eq!(positive["amount"], json!(100));
        let unreadable = translate_transaction(&transaction_with(json!({ "amount": "abc", "posted": null })), &account_with(json!({}))).unwrap();
        assert_eq!(unreadable["amount"], Json::Null);
        assert_eq!(unreadable["date"], json!(get_date_time_string_of(JsDate::from_ms(0.0))));
        let mut no_memo = transaction_with(json!({}));
        no_memo.as_object_mut().unwrap().remove("memo");
        no_memo.as_object_mut().unwrap().remove("posted");
        let no_memo = translate_transaction(&no_memo, &account_with(json!({}))).unwrap();
        assert_eq!(no_memo["label"], json!({}));
        assert_eq!(no_memo["date"], json!("NaN-NaN-NaNT00:00:00"));
    }

    #[test]
    fn translates_an_investment_transaction_as_a_one_unit_purchase() {
        let transaction = transaction_with(json!({ "id": "inv-txn-001", "amount": "500.00", "description": "Stock Purchase" }));
        let translated = translate_investment_transaction(&transaction, &account_with(json!({}))).unwrap();
        assert_eq!(translated["investment_transaction_id"], json!("inv-txn-001"));
        assert_eq!(translated["amount"], json!(500));
        assert_eq!(translated["quantity"], json!(1));
        assert_eq!(translated["price"], json!(500));
        assert_eq!(translated["name"], json!("Stock Purchase"));
        assert_eq!(translated["account_id"], json!("acc-001"));
        assert_eq!(translated["type"], json!("buy"));
        assert_eq!(translated["subtype"], json!("buy"));
        assert_eq!(translated["security_id"], Json::Null);
        assert_eq!(translated["label"], json!({}));
    }

    #[test]
    fn translates_a_holding_and_creates_its_security() {
        let TranslatedHolding { security, holding } = translate_holding(&holding_with(json!({})), &account_with(json!({}))).unwrap();
        assert!(crate::server::validation::is_uuid(&security["security_id"]));
        assert_eq!(security["ticker_symbol"], json!("AAPL"));
        assert_eq!(security["name"], json!("Apple Inc."));
        assert_eq!(security["iso_currency_code"], json!("USD"));
        assert_eq!(security["close_price"], json!(120));
        assert_eq!(security["isin"], Json::Null);
        assert_eq!(security["sector"], Json::Null);
        assert_eq!(holding["account_id"], json!("acc-001"));
        assert_eq!(holding["security_id"], security["security_id"]);
        assert_eq!(holding["holding_id"], json!("hold-001"));
        assert_eq!(holding["institution_value"], json!(1200));
        assert_eq!(holding["cost_basis"], json!(1000));
        assert_eq!(holding["quantity"], json!(10));
        let as_of = get_date_string(JsDate::from_ms(1704067200.0 * 1000.0));
        assert_eq!(security["close_price_as_of"], json!(as_of));
        assert_eq!(holding["institution_price_as_of"], json!(as_of));
    }

    #[test]
    fn a_holding_takes_its_own_currency_or_the_accounts() {
        let eur = translate_holding(&holding_with(json!({ "currency": "EUR" })), &account_with(json!({ "currency": "USD" }))).unwrap();
        assert_eq!(eur.security["iso_currency_code"], json!("EUR"));
        assert_eq!(eur.holding["iso_currency_code"], json!("EUR"));
        let gbp = translate_holding(&holding_with(json!({ "currency": "" })), &account_with(json!({ "currency": "GBP" }))).unwrap();
        assert_eq!(gbp.security["iso_currency_code"], json!("GBP"));
        assert_eq!(gbp.holding["iso_currency_code"], json!("GBP"));
    }

    #[test]
    fn the_close_price_is_the_market_value_per_share() {
        let holding = holding_with(json!({ "market_value": "500.00", "shares": "20" }));
        assert_eq!(translate_holding(&holding, &account_with(json!({}))).unwrap().security["close_price"], json!(25));
        let no_shares = holding_with(json!({ "shares": "0" }));
        assert_eq!(translate_holding(&no_shares, &account_with(json!({}))).unwrap().security["close_price"], Json::Null);
    }

    #[test]
    fn unary_plus_converts_as_javascript_does() {
        assert_eq!(unary_plus(Some(&json!("1500.50"))), 1500.5);
        assert_eq!(unary_plus(Some(&json!(" 12 "))), 12.0);
        assert_eq!(unary_plus(Some(&json!(""))), 0.0);
        assert_eq!(unary_plus(Some(&json!(null))), 0.0);
        assert!(unary_plus(None).is_nan());
        assert!(unary_plus(Some(&json!("1,000"))).is_nan());
        assert!(unary_plus(Some(&json!({}))).is_nan());
    }
}
