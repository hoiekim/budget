//! The cash position a broker reports only as part of an account's balance:
//! `src/server/lib/compute-tools/cash-holding.ts`.

use serde_json::json;

use crate::common::date::get_date_string;
use crate::common::utils::get_random_id;
use crate::js::{self, JsDate, Json, Obj};
use crate::server::postgres::repositories::securities::{search_securities, upsert_securities, SearchSecuritiesOptions};

/// Single canonical ticker for the auto-inferred USD cash holding. Plaid
/// itself uses tickers like `CUR:USD` for cash-equivalent securities; a
/// different label keeps the inferred-cash row distinguishable from a
/// broker-reported one at the data layer, while the UI treats them alike.
const USD_CASH_TICKER: &str = "USD";

/// Plaid's `AccountType.Investment`.
const INVESTMENT: &str = "investment";

/// Returns the global "USD Cash" security, creating it on first use. Every
/// user shares the same row, which is fine because the cash position itself
/// lives on the per-user holding, not the security.
pub async fn ensure_usd_cash_security() -> anyhow::Result<Obj> {
    let existing =
        search_securities(SearchSecuritiesOptions { ticker_symbol: Some(USD_CASH_TICKER.to_string()), ..Default::default() }).await?;
    if let Some(Json::Object(security)) = existing.into_iter().next() {
        return Ok(security);
    }

    let today = get_date_string(JsDate::now());
    let new_security = json!({
        "security_id": get_random_id(),
        "ticker_symbol": USD_CASH_TICKER,
        "name": "US Dollar Cash",
        "type": "cash",
        "close_price": 1,
        "close_price_as_of": today,
        "iso_currency_code": "USD",
        "isin": null,
        "cusip": null,
        "sedol": null,
        "institution_security_id": null,
        "institution_id": null,
        "proxy_security_id": null,
        "is_cash_equivalent": true,
        "update_datetime": null,
        "unofficial_currency_code": null,
        "market_identifier_code": null,
        "sector": null,
        "industry": null,
        "option_contract": null,
        "fixed_income": null,
    });
    let new_security = new_security.as_object().cloned().unwrap_or_default();
    upsert_securities(std::slice::from_ref(&new_security)).await;
    Ok(new_security)
}

/// `object?.key`: a value that is absent, `null` or not an object has no properties.
fn prop<'a>(object: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    match object {
        Some(Json::Object(object)) => object.get(key),
        _ => None,
    }
}

/// `value ?? fallback` for a number.
fn number_or(value: Option<&Json>, fallback: f64) -> f64 {
    match value {
        None | Some(Json::Null) => fallback,
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
    }
}

fn is_cash_like_security(sec: Option<&Obj>) -> bool {
    let Some(sec) = sec else { return false };
    if sec.get("type").and_then(Json::as_str) == Some("cash") {
        return true;
    }
    if js::truthy_opt(sec.get("is_cash_equivalent")) {
        return true;
    }
    // Plaid's `CUR:USD` / `CUR:EUR` style tickers for currency.
    sec.get("ticker_symbol").and_then(Json::as_str).is_some_and(|ticker| ticker.starts_with("CUR:"))
}

/// Holding-shaped cash detector, mirroring the client's `isCash` heuristic:
/// cash holdings always quote `institution_price = 1` and never carry a real
/// cost basis. This catches money-market funds and broker-proprietary cash
/// sweeps that don't surface as `type = 'cash'`, `is_cash_equivalent` or
/// `CUR:*` at the security layer.
///
/// A `null` or zero `cost_basis` covers both a database NULL and the `?? 0`
/// collapse that happens on serialisation, so this matches whether the
/// holding came straight from Plaid or round-tripped through the snapshot model.
fn is_holding_cash_like(h: &Obj, sec: Option<&Obj>) -> bool {
    if is_cash_like_security(sec) {
        return true;
    }
    let cost_basis = h.get("cost_basis");
    number_is(h.get("institution_price"), 1.0) && (matches!(cost_basis, Some(Json::Null)) || number_is(cost_basis, 0.0))
}

/// `value === n` for a number `n`.
fn number_is(value: Option<&Json>, n: f64) -> bool {
    matches!(value, Some(Json::Number(value)) if value.as_f64() == Some(n))
}

/// `Math.max(a, b)`: NaN when either is.
fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `a === b` between two possibly absent values.
fn strictly_equal(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a @ (Json::Null | Json::Bool(_) | Json::String(_))), Some(b)) => a == b,
        _ => false,
    }
}

/// Threshold (USD) below which the broker-reported delta is treated as
/// accumulated noise (pending sweeps, rounding) and no row is inferred.
/// Low enough to catch real cash positions, high enough to avoid showing a
/// $0.03 phantom holding.
const CASH_INFERENCE_MIN: f64 = 0.01;

/// For each investment account that doesn't already have a cash-like
/// holding, synthesises one to cover the broker-reported delta:
///
/// ```text
/// inferred_cash = max(0, account.balances.current − Σ(non-cash holdings))
/// ```
///
/// Returns the new holdings to merge into the sync's incoming holdings. The
/// downstream `upsert_and_delete_holdings_with_snapshots` then writes each as
/// a normal holding snapshot: the UI sees no difference between reported and
/// inferred cash.
///
/// Forward-only: historical cash positions are not inferred. The inferred row
/// gets a fresh snapshot dated now, and future syncs either update it or
/// supersede it (once the provider starts reporting cash as a real holding).
pub async fn infer_cash_holdings(accounts: &[Obj], incoming_holdings: &[Obj], securities: &[Obj]) -> anyhow::Result<Vec<Obj>> {
    infer_cash_holdings_with(accounts, incoming_holdings, securities, ensure_usd_cash_security).await
}

/// `infer_cash_holdings`, resolving the cash security with `resolve_cash_security`.
async fn infer_cash_holdings_with<F, Fut>(
    accounts: &[Obj],
    incoming_holdings: &[Obj],
    securities: &[Obj],
    mut resolve_cash_security: F,
) -> anyhow::Result<Vec<Obj>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Obj>>,
{
    // `new Map(securities.map((s) => [s.security_id, s])).get(id)`: the last one with that id.
    let security_by_id = |id: Option<&Json>| securities.iter().rev().find(|s| strictly_equal(s.get("security_id"), id));
    let mut result: Vec<Obj> = Vec::new();
    let mut cash_security: Option<Obj> = None;

    for account in accounts {
        if account.get("type").and_then(Json::as_str) != Some(INVESTMENT) {
            continue;
        }

        let account_holdings: Vec<&Obj> =
            incoming_holdings.iter().filter(|h| strictly_equal(h.get("account_id"), account.get("account_id"))).collect();

        let has_cash = account_holdings.iter().any(|h| is_holding_cash_like(h, security_by_id(h.get("security_id"))));
        if has_cash {
            continue;
        }

        let non_cash_total = account_holdings.iter().fold(0.0, |s, h| match h.get("institution_value") {
            Some(value) if !value.is_null() => s + value.as_f64().unwrap_or(f64::NAN),
            _ => {
                let qty = number_or(h.get("quantity"), 0.0);
                let price = number_or(h.get("institution_price"), 0.0);
                s + price * qty
            }
        });
        let balances = account.get("balances");
        let balance_current = number_or(prop(balances, "current"), 0.0);
        let inferred_cash = math_max(0.0, balance_current - non_cash_total);
        if inferred_cash < CASH_INFERENCE_MIN {
            continue;
        }

        // Resolve the cash security once, and only when needed.
        if cash_security.is_none() {
            cash_security = Some(resolve_cash_security().await?);
        }
        let cash_security_id = cash_security.as_ref().and_then(|s| s.get("security_id")).cloned().unwrap_or(Json::Null);
        let account_id = account.get("account_id");

        let mut holding = Obj::new();
        holding.insert(
            "holding_id".into(),
            json!(format!(
                "{}-{}",
                account_id.map(js::to_js_string).unwrap_or_else(|| "undefined".to_string()),
                js::to_js_string(&cash_security_id)
            )),
        );
        if let Some(account_id) = account_id {
            holding.insert("account_id".into(), account_id.clone());
        }
        holding.insert("security_id".into(), cash_security_id);
        holding.insert("quantity".into(), js::num(inferred_cash));
        holding.insert("institution_price".into(), json!(1));
        holding.insert("institution_price_as_of".into(), JsDate::now().to_json());
        holding.insert("institution_value".into(), js::num(inferred_cash));
        holding.insert("cost_basis".into(), js::num(inferred_cash));
        let iso_currency_code = match prop(balances, "iso_currency_code") {
            None | Some(Json::Null) => json!("USD"),
            Some(code) => code.clone(),
        };
        holding.insert("iso_currency_code".into(), iso_currency_code);
        holding.insert("unofficial_currency_code".into(), Json::Null);
        result.push(holding);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    // `cash-holding.test.ts`, "inferCashHoldings". The cash security comes
    // from a resolver that counts its calls in place of the securities table.

    fn obj(value: Json) -> Obj {
        value.as_object().cloned().unwrap()
    }

    fn with(base: Json, overrides: Json) -> Obj {
        let mut object = obj(base);
        object.extend(obj(overrides));
        object
    }

    fn account(overrides: Json) -> Obj {
        with(
            json!({
                "account_id": "acc-1",
                "type": "investment",
                "name": "Test Investment",
                "institution_id": "ins-1",
                "item_id": "item-1",
                "balances": { "current": 1000, "available": null, "limit": null, "iso_currency_code": "USD" },
                "hide": false,
                "custom_name": "",
                "label": {},
                "graphOptions": {},
            }),
            overrides,
        )
    }

    fn holding(overrides: Json) -> Obj {
        with(
            json!({
                "holding_id": "h-1",
                "account_id": "acc-1",
                "security_id": "sec-aapl",
                "quantity": 5,
                "institution_price": 100,
                "institution_price_as_of": "2026-05-01",
                "institution_value": 500,
                "cost_basis": 400,
                "iso_currency_code": "USD",
                "unofficial_currency_code": null,
            }),
            overrides,
        )
    }

    fn security(overrides: Json) -> Obj {
        with(
            json!({
                "security_id": "sec-aapl",
                "ticker_symbol": "AAPL",
                "name": "Apple Inc.",
                "type": "equity",
                "close_price": 100,
                "close_price_as_of": "2026-05-01",
                "iso_currency_code": "USD",
                "is_cash_equivalent": false,
            }),
            overrides,
        )
    }

    /// Runs the inference with a resolver that answers the canonical cash row; returns the holdings and how often it was asked.
    async fn infer(accounts: &[Obj], holdings: &[Obj], securities: &[Obj]) -> (Vec<Obj>, usize) {
        let calls = Cell::new(0);
        let result = infer_cash_holdings_with(accounts, holdings, securities, || {
            calls.set(calls.get() + 1);
            async { Ok(obj(json!({ "security_id": "sec-usd-cash", "ticker_symbol": "USD", "type": "cash" }))) }
        })
        .await
        .unwrap();
        (result, calls.get())
    }

    #[tokio::test]
    async fn synthesises_a_usd_cash_holding_when_the_balance_exceeds_the_non_cash_holdings() {
        let accounts = [account(json!({ "balances": { "current": 1500, "iso_currency_code": "USD" } }))];
        let (result, calls) = infer(&accounts, &[holding(json!({ "institution_value": 1000 }))], &[security(json!({}))]).await;
        assert_eq!(calls, 1);
        assert_eq!(result.len(), 1);
        let as_of = result[0]["institution_price_as_of"].clone();
        assert!((JsDate::from_json(&as_of).get_time() - JsDate::now_ms()).abs() < 60_000.0);
        assert_eq!(
            Json::Object(result[0].clone()),
            json!({
                "holding_id": "acc-1-sec-usd-cash",
                "account_id": "acc-1",
                "security_id": "sec-usd-cash",
                "quantity": 500,
                "institution_price": 1,
                "institution_price_as_of": as_of,
                "institution_value": 500,
                "cost_basis": 500,
                "iso_currency_code": "USD",
                "unofficial_currency_code": null,
            })
        );
    }

    #[tokio::test]
    async fn skips_when_a_cash_type_holding_already_exists_for_the_account() {
        let accounts = [account(json!({ "balances": { "current": 1500, "iso_currency_code": "USD" } }))];
        let holdings = [
            holding(json!({ "institution_value": 1000 })),
            holding(json!({ "holding_id": "h-2", "security_id": "sec-cash-1", "institution_value": 200 })),
        ];
        let securities = [security(json!({})), security(json!({ "security_id": "sec-cash-1", "ticker_symbol": "QACDS", "type": "cash" }))];
        assert_eq!(infer(&accounts, &holdings, &securities).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_a_holdings_ticker_matches_plaids_cur_pattern() {
        let accounts = [account(json!({ "balances": { "current": 1500 } }))];
        let holdings = [holding(json!({ "holding_id": "h-2", "security_id": "sec-cur-usd", "institution_value": 200 }))];
        let securities = [security(json!({ "security_id": "sec-cur-usd", "ticker_symbol": "CUR:USD", "type": null }))];
        assert_eq!(infer(&accounts, &holdings, &securities).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_is_cash_equivalent_is_true_on_the_security() {
        let accounts = [account(json!({ "balances": { "current": 1500 } }))];
        let holdings = [holding(json!({ "holding_id": "h-2", "security_id": "sec-money", "institution_value": 200 }))];
        let securities =
            [security(json!({ "security_id": "sec-money", "ticker_symbol": "VMFXX", "type": null, "is_cash_equivalent": true }))];
        assert_eq!(infer(&accounts, &holdings, &securities).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_a_holding_has_institution_price_1_and_a_zero_cost_basis() {
        let accounts = [account(json!({ "balances": { "current": 1500, "iso_currency_code": "USD" } }))];
        let holdings = [
            holding(json!({ "institution_value": 1000 })),
            holding(json!({
                "holding_id": "h-2",
                "security_id": "sec-vmfxx",
                "quantity": 200,
                "institution_price": 1,
                "institution_value": 200,
                "cost_basis": 0,
            })),
        ];
        let securities = [
            security(json!({})),
            security(json!({ "security_id": "sec-vmfxx", "ticker_symbol": "VMFXX", "type": "etf", "is_cash_equivalent": null })),
        ];
        assert_eq!(infer(&accounts, &holdings, &securities).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_cost_basis_is_null_and_institution_price_is_1() {
        let accounts = [account(json!({ "balances": { "current": 1500 } }))];
        let holdings = [holding(json!({
            "holding_id": "h-cash",
            "security_id": "sec-sweep",
            "quantity": 200,
            "institution_price": 1,
            "institution_value": 200,
            "cost_basis": null,
        }))];
        let securities = [security(json!({ "security_id": "sec-sweep", "ticker_symbol": "QACDS", "type": "etf" }))];
        assert_eq!(infer(&accounts, &holdings, &securities).await, (vec![], 0));
    }

    #[tokio::test]
    async fn an_absent_cost_basis_is_not_a_cash_sign() {
        // `cost_basis === null` is strict: a holding without the field is not cash-like.
        let accounts = [account(json!({ "balances": { "current": 1500 } }))];
        let mut sweep = holding(json!({ "security_id": "sec-sweep", "institution_price": 1, "institution_value": 200 }));
        sweep.shift_remove("cost_basis");
        let (result, calls) = infer(&accounts, &[sweep], &[]).await;
        assert_eq!((result.len(), calls), (1, 1));
        assert_eq!(result[0]["quantity"], json!(1300));
    }

    #[tokio::test]
    async fn skips_non_investment_accounts_entirely() {
        assert_eq!(infer(&[account(json!({ "type": "depository" }))], &[], &[]).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_the_inferred_amount_is_below_the_noise_threshold() {
        let accounts = [account(json!({ "balances": { "current": 1000 } }))];
        let holdings = [holding(json!({ "institution_value": 999.995 }))];
        assert_eq!(infer(&accounts, &holdings, &[security(json!({}))]).await, (vec![], 0));
    }

    #[tokio::test]
    async fn skips_when_the_balance_is_fully_reconciled_by_holdings() {
        let accounts = [account(json!({ "balances": { "current": 1000 } }))];
        let holdings = [holding(json!({ "institution_value": 1000 }))];
        assert_eq!(infer(&accounts, &holdings, &[security(json!({}))]).await, (vec![], 0));
    }

    #[tokio::test]
    async fn handles_a_mix_of_accounts_some_get_cash_some_dont() {
        let accounts = [
            account(json!({ "account_id": "acc-a", "balances": { "current": 2000, "iso_currency_code": "USD" } })),
            account(json!({ "account_id": "acc-b", "balances": { "current": 500, "iso_currency_code": "USD" } })),
            account(json!({ "account_id": "acc-c", "balances": { "current": 1000, "iso_currency_code": "USD" } })),
        ];
        let holdings = [
            holding(json!({ "account_id": "acc-a", "institution_value": 1500 })),
            holding(json!({ "account_id": "acc-b", "holding_id": "h-cash", "security_id": "sec-cash", "institution_value": 500 })),
            holding(json!({ "account_id": "acc-c", "institution_value": 1000 })),
        ];
        let securities = [security(json!({})), security(json!({ "security_id": "sec-cash", "ticker_symbol": "QACDS", "type": "cash" }))];
        let (result, _) = infer(&accounts, &holdings, &securities).await;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["account_id"], json!("acc-a"));
        assert_eq!(result[0]["quantity"], json!(500));
    }

    #[tokio::test]
    async fn returns_no_holdings_and_resolves_nothing_when_input_is_empty() {
        assert_eq!(infer(&[], &[], &[]).await, (vec![], 0));
    }

    #[tokio::test]
    async fn resolves_the_cash_security_once_across_accounts_that_need_cash() {
        let accounts = [
            account(json!({ "account_id": "acc-a", "balances": { "current": 1000 } })),
            account(json!({ "account_id": "acc-b", "balances": { "current": 2000 } })),
        ];
        let (result, calls) = infer(&accounts, &[], &[]).await;
        assert_eq!((result.len(), calls), (2, 1));
        // A balance with no currency is taken as US dollars.
        assert_eq!(result[1]["iso_currency_code"], json!("USD"));
        assert_eq!(result[1]["holding_id"], json!("acc-b-sec-usd-cash"));
    }

    #[tokio::test]
    async fn a_holding_without_a_value_counts_at_quantity_times_price() {
        let accounts = [account(json!({ "balances": { "current": 1000, "iso_currency_code": "EUR" } }))];
        let holdings = [holding(json!({ "institution_value": null, "quantity": 3, "institution_price": 100 }))];
        let (result, _) = infer(&accounts, &holdings, &[]).await;
        assert_eq!(result[0]["quantity"], json!(700));
        assert_eq!(result[0]["iso_currency_code"], json!("EUR"));
    }

    #[test]
    fn math_max_is_nan_when_either_side_is() {
        assert!(math_max(0.0, f64::NAN).is_nan());
        assert_eq!(math_max(0.0, -5.0), 0.0);
    }
}
