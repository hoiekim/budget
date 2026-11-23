//! `POST /snapshots/holding`: `src/server/routes/accounts/post-holding-snapshot.ts`.

use serde_json::json;

use crate::common::date::get_squashed_date_string;
use crate::common::utils::get_random_id;
use crate::js::{self, JsDate, Json, Obj};
use crate::server::compute_tools::backfill_snapshots::{backfill_monthly_security_snapshots_forward, BackfillOptions, BackfillSecurityRef};
use crate::server::logger;
use crate::server::market_data::get_ticker_detail_with_fallback;
use crate::server::polygon::{self, LookupOptions, PolygonErrorKind};
use crate::server::postgres::database::shared_with;
use crate::server::postgres::models::{account, snapshot, MaskedUser, UpdateArgs};
use crate::server::postgres::repositories::holdings::upsert_holdings;
use crate::server::postgres::repositories::securities::{get_security, search_securities, upsert_securities, SearchSecuritiesOptions};
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::postgres::repositories::snapshots::{get_holding_snapshot_by_id, upsert_holding_snapshots};
use crate::server::rate_limit::{POLYGON_LOOKUP_RATE_LIMITER, POLYGON_LOOKUP_SHED_MESSAGE};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    js_trim, optional_date_field, require_body_object, require_ticker_symbol, validate_fields, validation_error, FieldSpec, FieldType,
    DECIMAL_15_2_MAX, DECIMAL_15_6_MAX,
};

/// The numeric fields a holding-snapshot edit can set, mirroring their
/// DECIMAL columns in `models/snapshot.rs` (QUANTITY DECIMAL(15, 6),
/// COST_BASIS / INSTITUTION_VALUE DECIMAL(15, 2), INSTITUTION_PRICE
/// DECIMAL(15, 6)). All four columns are nullable, so an explicit null clears
/// the column rather than failing.
///
/// Both specs are checked before the ownership lookup: a client type error is
/// a `failed` answer with the field named, never an error at the write that
/// the route layer turns into a 500 and an alarm. The bounds mirror the
/// columns, so an overflowing value is refused here with the limit named.
const HOLDING_SNAPSHOT_PATCH_SPEC: &[FieldSpec] = &[
    FieldSpec::new("quantity", FieldType::Number).nullable().max(DECIMAL_15_6_MAX),
    FieldSpec::new("cost_basis", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("institution_price", FieldType::Number).nullable().max(DECIMAL_15_6_MAX),
    FieldSpec::new("institution_value", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
];

const HOLDING_SNAPSHOT_CREATE_SPEC: &[FieldSpec] = &[
    FieldSpec::new("quantity", FieldType::Number).required().max(DECIMAL_15_6_MAX),
    FieldSpec::new("cost_basis", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
    FieldSpec::new("institution_price", FieldType::Number).nullable().max(DECIMAL_15_6_MAX),
    FieldSpec::new("institution_value", FieldType::Number).nullable().max(DECIMAL_15_2_MAX),
];

/// The amounts a holding snapshot can carry, in the order they are written.
const AMOUNTS: [&str; 4] = ["quantity", "cost_basis", "institution_price", "institution_value"];

/// `value ?? 0` for an amount that is a number, `null` or absent.
fn number_or_zero(value: Option<&Json>) -> f64 {
    match value {
        None | Some(Json::Null) => 0.0,
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
    }
}

/// `value ?? fallback`.
fn or_else(value: Option<&Json>, fallback: impl FnOnce() -> Json) -> Json {
    match value {
        None | Some(Json::Null) => fallback(),
        Some(value) => value.clone(),
    }
}

/// The holdings row derives `institution_value` from `quantity *
/// institution_price` when the caller leaves it unset, and the product of two
/// DECIMAL(15, 6) values is not bounded by either spec: quantity 1e8 and
/// institution_price 1e8 both pass, yet their product 1e16 overflows the
/// holdings DECIMAL(15, 2) column. `upsert_holdings` swallows that failure
/// per row, so without this guard the route would answer success with a
/// missing or stale holdings row. Returns the refusal message (naming the
/// limit the way the spec refusal does) when the derived value would
/// overflow, or `None` when the combination is safe, including when the
/// caller sets `institution_value` explicitly, since then nothing is derived.
/// Magnitude, not value: the column overflows on either sign.
fn derived_institution_value_overflow(
    quantity: Option<&Json>,
    institution_price: Option<&Json>,
    institution_value: Option<&Json>,
) -> Option<String> {
    if institution_value.is_some_and(|value| !value.is_null()) {
        return None;
    }
    if (number_or_zero(quantity) * number_or_zero(institution_price)).abs() > DECIMAL_15_2_MAX {
        return Some(format!("Field institution_value must be at most {}", js::number_to_string(DECIMAL_15_2_MAX)));
    }
    None
}

/// `currency_name.toUpperCase()` on what the upstream sent, failing where the TypeScript throws.
fn upper_case_currency(currency_name: &Option<Json>) -> anyhow::Result<String> {
    match currency_name {
        Some(Json::String(currency_name)) => Ok(currency_name.to_uppercase()),
        None => anyhow::bail!("undefined is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(_) => anyhow::bail!(
            "currency_name.toUpperCase is not a function. (In 'currency_name.toUpperCase()', 'currency_name.toUpperCase' is undefined)"
        ),
    }
}

/// `date.toISOString().split("T")[0]`.
fn iso_day(date: JsDate) -> anyhow::Result<String> {
    let iso = date.to_iso_string().ok_or_else(|| anyhow::anyhow!("Invalid Date"))?;
    Ok(iso.split('T').next().unwrap_or_default().to_string())
}

/// A template literal's text for a value: `undefined` when it is absent.
fn interpolate(value: Option<&Json>) -> String {
    value.map(js::to_js_string).unwrap_or_else(|| "undefined".to_string())
}

/// Resolves an already-validated ticker symbol to a security id, creating
/// the security from the market data's ticker detail when it is not stored
/// yet. The price is intentionally not required, so a future-dated snapshot
/// does not falsely reject a valid ticker (the validate-ticker route is as
/// lenient). `Err` inside is the refusal to answer.
async fn resolve_security_id(upper_ticker: &str, user_id: &str) -> anyhow::Result<Result<String, String>> {
    let securities =
        search_securities(SearchSecuritiesOptions { ticker_symbol: Some(upper_ticker.to_string()), ..Default::default() }).await?;
    if let Some(security) = securities.first() {
        return Ok(Ok(interpolate(security.get("security_id"))));
    }

    // Past the local short-circuit this reaches the same process-wide gate as
    // /validate-ticker, on the same per-user budget.
    if POLYGON_LOOKUP_RATE_LIMITER.is_limited(user_id) {
        return Ok(Err(POLYGON_LOOKUP_SHED_MESSAGE.to_string()));
    }
    POLYGON_LOOKUP_RATE_LIMITER.consume(user_id, 1);

    // Resolve via Polygon, falling back to Yahoo for symbols Polygon does not
    // carry (mutual funds, chiefly).
    let options = LookupOptions { max_wait_ms: Some(polygon::FOREGROUND_QUEUE_WAIT_MS), ..Default::default() };
    let detail = match get_ticker_detail_with_fallback(upper_ticker, &options).await? {
        Ok(detail) => detail,
        // Asking the caller to check the symbol is only the right answer when
        // Polygon actually came back empty on it. Every other failure is about
        // the lookup, not the ticker, and carries its own message.
        Err(failure) => {
            return Ok(Err(match failure.error {
                PolygonErrorKind::NoApiKey => "Market data API is not configured. Contact your administrator.".to_string(),
                PolygonErrorKind::NoData => {
                    format!("Ticker symbol \"{upper_ticker}\" could not be validated. Please check the symbol and try again.")
                }
                _ => failure.message,
            }));
        }
    };

    let security_id = get_random_id();
    let mut new_security = Obj::new();
    new_security.insert("security_id".into(), json!(security_id));
    new_security.insert("ticker_symbol".into(), json!(upper_ticker));
    if let Some(name) = &detail.name {
        new_security.insert("name".into(), name.clone());
    }
    new_security.insert("iso_currency_code".into(), json!(upper_case_currency(&detail.currency_name)?));
    for key in [
        "close_price",
        "close_price_as_of",
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
        new_security.insert(key.into(), Json::Null);
    }
    upsert_securities(std::slice::from_ref(&new_security)).await;
    Ok(Ok(security_id))
}

/// Records a holding's position on a day (create mode), or, given a
/// `snapshot_id`, changes only the fields the body names on that snapshot
/// (update mode, the on-blur edit of the holding detail page). Either way the
/// current-holdings row follows the snapshot.
async fn post_holding_snapshot(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    match body.get("snapshot_id") {
        Some(snapshot_id) if js::truthy(snapshot_id) => update_holding_snapshot(&user, &body, snapshot_id.clone()).await,
        _ => create_holding_snapshot(&user, &body).await,
    }
}

async fn update_holding_snapshot(user: &MaskedUser, body: &Obj, provided_snapshot_id: Json) -> HandlerResult {
    if let Err(message) = validate_fields(body, HOLDING_SNAPSHOT_PATCH_SPEC) {
        return Ok(validation_error(message).into());
    }

    let Some(existing) = get_holding_snapshot_by_id(user, provided_snapshot_id.clone()).await? else {
        return Ok(ApiResponse::failed("Snapshot not found or access denied.").into());
    };

    let mut patch = Obj::new();
    let mut new_security_id: Option<String> = None;

    if let Some(Json::String(ticker_symbol)) = body.get("ticker_symbol") {
        if !js_trim(ticker_symbol).is_empty() {
            let patch_ticker = match require_ticker_symbol(body, "ticker_symbol") {
                Ok(patch_ticker) => patch_ticker,
                Err(message) => return Ok(validation_error(message).into()),
            };
            let security_id = match resolve_security_id(&patch_ticker, &user.user_id).await? {
                Ok(security_id) => security_id,
                Err(message) => return Ok(ApiResponse::failed(message).into()),
            };
            patch.insert("holding_security_id".into(), json!(security_id));
            new_security_id = Some(security_id);
        }
    }
    let parsed_patch_date = match optional_date_field(body, "snapshot_date", None) {
        Ok(parsed_patch_date) => parsed_patch_date,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Some(date) = parsed_patch_date {
        patch.insert("snapshot_date".into(), json!(iso_day(date)?));
    }
    for amount in AMOUNTS {
        if let Some(value) = body.get(amount) {
            patch.insert(amount.into(), value.clone());
        }
    }

    if patch.is_empty() {
        return Ok(validation_error("no fields to update").into());
    }

    // The re-sync below derives the holdings row's institution_value from the
    // patched quantity * institution_price when the snapshot carries no
    // explicit value: the same overflow the create path refuses. The
    // effective post-patch values (body over the stored row) are checked
    // before the snapshot write, so a refused combination leaves no written
    // snapshot behind a stale holdings row.
    let effective = |amount: &str| body.get(amount).or_else(|| existing.get(amount));
    if let Some(message) =
        derived_institution_value_overflow(effective("quantity"), effective("institution_price"), effective("institution_value"))
    {
        return Ok(validation_error(message).into());
    }

    let updated = async {
        snapshot::TABLE
            .update(&provided_snapshot_id, &patch, UpdateArgs { user_id: Some(shared_with(user)), ..Default::default() })
            .await?;

        // Re-sync the current-holdings row from the latest snapshot state so
        // portfolio value calculations stay consistent with the edit.
        if let Some(refreshed) = get_holding_snapshot_by_id(user, provided_snapshot_id.clone()).await? {
            let security_id = refreshed.get("holding_security_id").cloned().unwrap_or(Json::Null);
            let account_id = refreshed.get("holding_account_id").cloned().unwrap_or(Json::Null);
            let quantity = refreshed.get("quantity");
            let institution_price = refreshed.get("institution_price");
            let holding = json!({
                "holding_id": format!("{}-{}", js::to_js_string(&account_id), js::to_js_string(&security_id)),
                "account_id": account_id,
                "security_id": security_id,
                "quantity": or_else(quantity, || json!(0)),
                "cost_basis": or_else(refreshed.get("cost_basis"), || Json::Null),
                "institution_price": or_else(institution_price, || json!(0)),
                "institution_price_as_of": refreshed.get("snapshot_date"),
                "institution_value": or_else(refreshed.get("institution_value"), || {
                    js::num(number_or_zero(quantity) * number_or_zero(institution_price))
                }),
                "iso_currency_code": null,
                "unofficial_currency_code": null,
            });
            let owner = match account_id.as_str() {
                Some(account_id) => get_row_owner(user, &account::TABLE, account_id).await?,
                None => None,
            };
            if let (Some(owner), Json::Object(holding)) = (owner, holding) {
                upsert_holdings(&owner, &[holding]).await;
            }
        }
        anyhow::Ok(())
    };
    if let Err(error) = updated.await {
        logger::error("Failed to update holding snapshot", Some(&crate::ctx! { "snapshot_id": provided_snapshot_id }), Some(&error));
        return Err(error);
    }

    let security_id = match new_security_id {
        Some(security_id) => json!(security_id),
        None => existing.get("holding_security_id").cloned().unwrap_or(Json::Null),
    };
    Ok(ApiResponse::success_with(json!({ "snapshot_id": provided_snapshot_id, "security_id": security_id })).into())
}

async fn create_holding_snapshot(user: &MaskedUser, body: &Obj) -> HandlerResult {
    let account_id = body.get("account_id");
    if !js::truthy_opt(account_id) {
        return Ok(validation_error("account_id is required").into());
    }
    let Some(Json::String(account_id)) = account_id else {
        return Ok(validation_error("account_id must be a string").into());
    };
    // A known security can be named by id, so a ticker two security rows
    // share can't send the snapshot to the other one.
    let given_security_id = match body.get("security_id") {
        None => None,
        Some(Json::String(security_id)) => Some(security_id.as_str()).filter(|security_id| !security_id.is_empty()),
        Some(_) => return Ok(validation_error("security_id must be a string").into()),
    };
    let ticker = match given_security_id {
        Some(_) => None,
        None => match require_ticker_symbol(body, "ticker_symbol") {
            Ok(ticker) => Some(ticker),
            Err(message) => return Ok(validation_error(message).into()),
        },
    };
    // `quantity` is the only required number; the other three are optional
    // and nullable. Checked before the ownership lookup, so the refusal
    // issues no SQL and no alarm.
    if let Err(message) = validate_fields(body, HOLDING_SNAPSHOT_CREATE_SPEC) {
        return Ok(validation_error(message).into());
    }
    let quantity = body.get("quantity").cloned().unwrap_or(Json::Null);
    let institution_price = body.get("institution_price");
    let institution_value = body.get("institution_value");

    // The holdings row derives institution_value from quantity *
    // institution_price when the caller leaves it unset. The combination is
    // refused here, before the ownership lookup, when the derived value would
    // overflow the holdings DECIMAL(15, 2) column.
    if let Some(message) = derived_institution_value_overflow(Some(&quantity), institution_price, institution_value) {
        return Ok(validation_error(message).into());
    }

    let parsed_date = match optional_date_field(body, "snapshot_date", None) {
        Ok(parsed_date) => parsed_date,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let Some(owner) = get_row_owner(user, &account::TABLE, account_id).await? else {
        return Ok(ApiResponse::failed("Account not found or access denied.").into());
    };

    let date = parsed_date.unwrap_or_else(JsDate::now);
    let date_string = get_squashed_date_string(date);

    let security_id = match (given_security_id, &ticker) {
        (Some(given_security_id), _) => {
            if get_security(given_security_id).await?.is_none() {
                return Ok(ApiResponse::failed("Security not found.").into());
            }
            given_security_id.to_string()
        }
        (None, ticker) => match resolve_security_id(ticker.as_deref().unwrap_or_default(), &user.user_id).await? {
            Ok(security_id) => security_id,
            Err(message) => return Ok(ApiResponse::failed(message).into()),
        },
    };

    // Deterministic snapshot id, so a duplicate (account, security, date)
    // tuple updates in place rather than producing duplicate rows.
    let snapshot_id = format!("holding-{account_id}-{security_id}-{date_string}");

    let mut snapshot = Obj::new();
    snapshot.insert("snapshot_id".into(), json!(snapshot_id));
    snapshot.insert("snapshot_date".into(), json!(iso_day(date)?));
    snapshot.insert("holding_account_id".into(), json!(account_id));
    snapshot.insert("holding_security_id".into(), json!(security_id));
    for amount in AMOUNTS {
        if let Some(value) = body.get(amount) {
            snapshot.insert(amount.into(), value.clone());
        }
    }

    let date_iso = date.to_iso_string().ok_or_else(|| anyhow::anyhow!("Invalid Date"))?;
    upsert_holding_snapshots(&owner, &[snapshot]).await;

    let holding = json!({
        "holding_id": format!("{account_id}-{security_id}"),
        "account_id": account_id,
        "security_id": security_id,
        "quantity": quantity,
        "cost_basis": or_else(body.get("cost_basis"), || Json::Null),
        "institution_price": or_else(institution_price, || json!(0)),
        "institution_price_as_of": date_iso,
        "institution_value": or_else(institution_value, || {
            js::num(number_or_zero(Some(&quantity)) * number_or_zero(institution_price))
        }),
        "iso_currency_code": null,
        "unofficial_currency_code": null,
    });
    if let Json::Object(holding) = holding {
        upsert_holdings(&owner, &[holding]).await;
    }

    // Fire-and-forget monthly snapshot backfill from this snapshot's date
    // forward. A manual post can backdate `snapshot_date`, in which case
    // this is the path that fills the months between then and now.
    let refs = [BackfillSecurityRef { security_id: security_id.clone(), from_date: date_iso }];
    let (backfilled_security_id, backfilled_snapshot_id) = (security_id.clone(), snapshot_id.clone());
    tokio::spawn(async move {
        if let Err(error) = backfill_monthly_security_snapshots_forward(&refs, BackfillOptions::default()).await {
            logger::error(
                "backfillMonthlySecuritySnapshotsForward failed (post-holding)",
                Some(&crate::ctx! { "security_id": backfilled_security_id, "snapshot_id": backfilled_snapshot_id }),
                Some(&error),
            );
        }
    });

    Ok(ApiResponse::success_with(json!({ "snapshot_id": snapshot_id, "security_id": security_id })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/snapshots/holding", post_holding_snapshot)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_value_derives_nothing_and_an_overflowing_product_is_refused() {
        let big = json!(1e8);
        assert_eq!(derived_institution_value_overflow(Some(&big), Some(&big), Some(&json!(1))), None);
        assert_eq!(
            derived_institution_value_overflow(Some(&big), Some(&big), None).as_deref(),
            Some("Field institution_value must be at most 9999999999999.99")
        );
        assert_eq!(
            derived_institution_value_overflow(Some(&json!(-1e8)), Some(&big), Some(&Json::Null)).as_deref(),
            Some("Field institution_value must be at most 9999999999999.99")
        );
        assert_eq!(derived_institution_value_overflow(Some(&big), None, None), None);
        assert_eq!(derived_institution_value_overflow(None, Some(&Json::Null), None), None);
    }
}
