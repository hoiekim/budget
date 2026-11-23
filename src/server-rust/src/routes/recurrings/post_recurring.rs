//! `POST /recurrings`: `src/server/routes/recurrings/post-recurring.ts`.

use serde_json::json;

use crate::filters;
use crate::js::{math_round, num, truthy, truthy_opt, Json, JsDate, Obj};
use crate::server::compute_tools::detect_recurrings::normalize_merchant_name;
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::common::{TRANSACTION_ID, USER_ID};
use crate::server::postgres::models::{recurring, transaction, MaskedUser};
use crate::server::postgres::repositories::recurrings::{
    add_to_recurring, confirm_recurring, create_recurring, get_recurrings, rename_recurring, set_recurring_label,
    set_recurring_splits, CreateRecurringInput, GetRecurringsOptions, Recurring, RecurringConfirmResult, RecurringResult,
};
use crate::server::postgres::repositories::sharing::get_row_owner;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    js_trim, require_body_object, validate_fields, validation_error, FieldSpec, FieldType, Validation,
};

/// The cadence a median interval (in days) reads as, for a recurring made by
/// hand: the first whose bound it does not exceed.
const CADENCE_BY_DAYS: [(f64, &str); 6] = [
    (10.0, "weekly"),
    (21.0, "biweekly"),
    (45.0, "monthly"),
    (120.0, "quarterly"),
    (270.0, "semiannual"),
    (f64::INFINITY, "annual"),
];

const MAX_SPLITS: usize = 20;

const SPLIT_SPEC: [FieldSpec; 3] = [
    FieldSpec::new("amount", FieldType::Number).required(),
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_id", FieldType::Uuid).nullable(),
];

const LABEL_SPEC: [FieldSpec; 2] = [
    FieldSpec::new("label.budget_id", FieldType::Uuid).nullable(),
    FieldSpec::new("label.category_id", FieldType::Uuid).nullable(),
];

/// `value ?? null` for a key of an optional object.
fn or_null(object: Option<&Obj>, key: &str) -> Json {
    object.and_then(|object| object.get(key)).cloned().unwrap_or(Json::Null)
}

/// `{ budget_id, category_id }` from an optional label object, each `?? null`.
fn label_of(label: Option<&Obj>) -> Obj {
    let mut out = Obj::new();
    out.insert("budget_id".into(), or_null(label, "budget_id"));
    out.insert("category_id".into(), or_null(label, "category_id"));
    out
}

/// The body's `splits` as `JSONRecurringSplit`s: amounts rounded to cents,
/// labels filled in with nulls.
fn parse_splits(value: Option<&Json>) -> Validation<Vec<Json>> {
    let Some(Json::Array(items)) = value else { return Err("splits must be an array".to_string()) };
    if items.len() > MAX_SPLITS {
        return Err(format!("A recurring can have at most {MAX_SPLITS} splits"));
    }
    let mut splits = Vec::new();
    for item in items {
        let fields = match item {
            Json::Object(fields) => fields,
            // An array passes as an object, and then has no fields to check.
            Json::Array(_) => return Err("Field amount must be an object".to_string()),
            _ => return Err("Each split must be an object".to_string()),
        };
        validate_fields(fields, &SPLIT_SPEC)?;
        let amount = fields.get("amount").and_then(Json::as_f64).unwrap_or(f64::NAN);
        let label = fields.get("label").and_then(Json::as_object);
        let cents = math_round(amount * 100.0) / 100.0;
        if cents <= 0.0 {
            return Err("Each split amount must be positive".to_string());
        }
        let mut split = Obj::new();
        split.insert("amount".into(), num(cents));
        split.insert("label".into(), Json::Object(label_of(label)));
        splits.push(Json::Object(split));
    }
    Ok(splits)
}

/// The recurring as it now stands, members' labels included, for the writing
/// tab to apply directly (it filters out its own realtime event).
async fn read_back(user: &MaskedUser, recurring_id: &str) -> anyhow::Result<Option<Recurring>> {
    let recurrings = get_recurrings(
        user,
        GetRecurringsOptions { recurring_ids: Some(vec![recurring_id.to_string()]), ..Default::default() },
    )
    .await?;
    Ok(recurrings.into_iter().next())
}

/// `{ recurring_id, recurring }`, without `recurring` when it no longer reads back.
async fn with_recurring(user: &MaskedUser, recurring_id: &str) -> anyhow::Result<ApiResponse> {
    let mut body = Obj::new();
    body.insert("recurring_id".into(), json!(recurring_id));
    if let Some(recurring) = read_back(user, recurring_id).await? {
        body.insert("recurring".into(), recurring);
    }
    Ok(ApiResponse::success_with(Json::Object(body)))
}

/// The string ids among `ids`.
fn string_ids(ids: &[Json]) -> Vec<String> {
    ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()
}

/// `t.merchant_name || t.name`, or `None` when both are empty.
fn name_of(transaction: &Json) -> Option<&str> {
    ["merchant_name", "name"]
        .into_iter()
        .filter_map(|key| transaction.get(key))
        .find(|value| truthy(value))
        .and_then(Json::as_str)
}

fn days_between_local(a: &str, b: &str) -> f64 {
    let midnight = |date: &str| JsDate::parse(&format!("{date}T00:00:00")).get_time();
    math_round((midnight(b) - midnight(a)) / 86_400_000.0)
}

/// Works on a recurring (`recurring_id`, with `transaction_ids`,
/// `merchant_name`, `splits` or `label`, or alone to confirm it), or creates
/// one from `transaction_ids`.
async fn post_recurring(ctx: &mut Ctx) -> HandlerResult {
    let Some(requester) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let body = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };

    // A recurring belongs to the owner of its transactions, and the detection
    // job reads and locks it under that owner. A request from someone sharing
    // data with the owner is carried out as the owner; an id outside the
    // requester's reach stays the requester's, and is then not found.
    let anchor = match (body.get("recurring_id"), body.get("transaction_ids")) {
        (Some(Json::String(recurring_id)), _) => get_row_owner(&requester, &recurring::TABLE, recurring_id).await?,
        (_, Some(Json::Array(ids))) => match ids.first() {
            Some(Json::String(first)) => get_row_owner(&requester, &transaction::TABLE, first).await?,
            _ => None,
        },
        _ => None,
    };
    let user = anchor.unwrap_or(requester);

    // With recurring_id and transaction_ids, add those transactions to the
    // existing recurring (the detail page's "add to recurring" affordance);
    // with merchant_name, rename it; with label, set its default
    // budget/category; with splits, set the splits its joining charges take.
    // With recurring_id alone, confirm a suggested recurring.
    if let Some(Json::String(recurring_id)) = body.get("recurring_id") {
        if let Some(Json::Array(ids)) = body.get("transaction_ids") {
            let transaction_ids = string_ids(ids);
            return Ok(match add_to_recurring(&user, recurring_id, &transaction_ids).await? {
                RecurringResult::Ok { .. } => with_recurring(&user, recurring_id).await?,
                RecurringResult::Failed { error } => ApiResponse::failed(error),
            }
            .into());
        }
        if let Some(merchant_name) = body.get("merchant_name") {
            let name = match merchant_name {
                Json::String(name) => js_trim(name),
                _ => "",
            };
            if name.is_empty() {
                return Ok(validation_error("merchant_name must be a non-empty string").into());
            }
            return Ok(match rename_recurring(&user, recurring_id, name).await? {
                RecurringConfirmResult::Ok => ApiResponse::success_with(json!({ "recurring_id": recurring_id })),
                RecurringConfirmResult::Failed { error } => ApiResponse::failed(error),
            }
            .into());
        }
        if body.contains_key("splits") {
            let splits = match parse_splits(body.get("splits")) {
                Ok(splits) => splits,
                Err(message) => return Ok(validation_error(message).into()),
            };
            return Ok(match set_recurring_splits(&user, recurring_id, &splits).await? {
                RecurringConfirmResult::Ok => with_recurring(&user, recurring_id).await?,
                RecurringConfirmResult::Failed { error } => ApiResponse::failed(error),
            }
            .into());
        }
        if body.contains_key("label") {
            if let Err(message) = validate_fields(&body, &LABEL_SPEC) {
                return Ok(validation_error(message).into());
            }
            let label = match body.get("label") {
                Some(Json::Object(label)) => label,
                _ => return Ok(validation_error("label must be an object").into()),
            };
            return Ok(match set_recurring_label(&user, recurring_id, &label_of(Some(label))).await? {
                RecurringConfirmResult::Ok => with_recurring(&user, recurring_id).await?,
                RecurringConfirmResult::Failed { error } => ApiResponse::failed(error),
            }
            .into());
        }
        return Ok(match confirm_recurring(&user, recurring_id).await? {
            RecurringConfirmResult::Ok => with_recurring(&user, recurring_id).await?,
            RecurringConfirmResult::Failed { error } => ApiResponse::failed(error),
        }
        .into());
    }

    // Otherwise create a new recurring from explicit transaction ids (the
    // "mark as recurring" affordance). Manual creation is user intent, not a
    // suggestion: the members just have to agree on one merchant group and
    // one direction; the cadence is estimated from the median interval
    // without the detection pass's tolerance gate.
    let Some(Json::Array(ids)) = body.get("transaction_ids") else {
        return Ok(validation_error("transaction_ids must be an array of transaction ids").into());
    };
    let transaction_ids = string_ids(ids);
    if transaction_ids.is_empty() {
        return Ok(validation_error("at least one transaction is required").into());
    }

    let rows = transaction::TABLE
        .query(
            filters! { USER_ID => user.user_id.as_str() },
            SearchFilters {
                in_filters: vec![(TRANSACTION_ID.to_string(), transaction_ids.iter().map(|id| json!(id)).collect())],
                ..Default::default()
            },
            None,
        )
        .await?;
    let txns: Vec<Json> = rows
        .iter()
        .map(transaction::to_json)
        .filter(|t| {
            !truthy_opt(t.get("is_deleted"))
                && !truthy_opt(t.get("pending"))
                && !matches!(t.get("amount"), Some(Json::Number(n)) if n.as_f64() == Some(0.0))
        })
        .collect();
    if txns.len() != transaction_ids.len() {
        return Ok(ApiResponse::failed(
            "One or more transactions no longer exist (deleted or never belonged to this user).",
        )
        .into());
    }

    let keys: Vec<String> = txns.iter().map(|t| normalize_merchant_name(name_of(t).unwrap_or(""))).collect();
    let directions: Vec<bool> =
        txns.iter().map(|t| t.get("amount").and_then(Json::as_f64).is_some_and(|amount| amount < 0.0)).collect();
    let merchant_key = keys[0].clone();
    let is_income = directions[0];
    if merchant_key.is_empty() || !keys.iter().all(|k| *k == merchant_key) || !directions.iter().all(|d| *d == is_income) {
        return Ok(ApiResponse::failed(
            "Those transactions don't form a single recurring group (same merchant and direction).",
        )
        .into());
    }

    let mut dates: Vec<String> = txns
        .iter()
        .map(|t| t.get("date").and_then(Json::as_str).unwrap_or("").chars().take(10).collect())
        .collect();
    dates.sort();
    let mut intervals: Vec<f64> = dates.windows(2).map(|pair| days_between_local(&pair[0], &pair[1])).collect();
    // A single transaction has no interval to measure, so default to monthly.
    // The detection job's auto-attach (`select_confirmed_attachments`) doesn't
    // trust it: until a recurring has two members it takes a charge one
    // period of any cadence later, and from then on it measures the cadence
    // from the members.
    let mut cadence = "monthly";
    if !intervals.is_empty() {
        intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_interval = intervals[intervals.len() / 2];
        // Only a NaN interval finds no bound; stored dates always parse, so
        // this fails, as reading `.cadence` of nothing does, only on a bad row.
        match CADENCE_BY_DAYS.iter().find(|(max_days, _)| median_interval <= *max_days) {
            Some((_, found)) => cadence = found,
            None => anyhow::bail!("undefined is not an object (evaluating 'CADENCE_BY_DAYS.find(...).cadence')"),
        }
    }

    // A caller-supplied name wins (the detail page's "name this recurring"
    // input); otherwise fall back to the most common merchant_name among the
    // members.
    let custom_name = match body.get("merchant_name") {
        Some(Json::String(name)) if !js_trim(name).is_empty() => Some(js_trim(name).to_string()),
        _ => None,
    };
    let merchant_name = match &custom_name {
        Some(name) => name.clone(),
        None => {
            let mut counts: Vec<(&str, usize)> = Vec::new();
            let mut best = 0;
            let mut chosen = "";
            for t in &txns {
                let n = name_of(t).unwrap_or("");
                let count = match counts.iter_mut().find(|(name, _)| *name == n) {
                    Some((_, count)) => {
                        *count += 1;
                        *count
                    }
                    None => {
                        counts.push((n, 1));
                        1
                    }
                };
                if count > best {
                    best = count;
                    chosen = n;
                }
            }
            chosen.to_string()
        }
    };

    let result = create_recurring(
        &user,
        CreateRecurringInput {
            transaction_ids,
            merchant_key,
            merchant_name,
            name_is_custom: custom_name.is_some(),
            cadence: cadence.to_string(),
            is_income,
        },
    )
    .await?;
    Ok(match result {
        RecurringResult::Ok { recurring_id } => with_recurring(&user, &recurring_id).await?,
        RecurringResult::Failed { error } => ApiResponse::failed(error),
    }
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/recurrings", post_recurring)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn splits(value: Json) -> Validation<Vec<Json>> {
        parse_splits(Some(&value))
    }

    // `post-recurring.test.ts`, "default splits", and the checks in front of the database.
    #[test]
    fn splits_must_be_an_array_of_at_most_twenty() {
        assert_eq!(parse_splits(None), Err("splits must be an array".into()));
        assert_eq!(splits(json!(null)), Err("splits must be an array".into()));
        assert_eq!(splits(json!({ "amount": 1 })), Err("splits must be an array".into()));
        let many: Vec<Json> = (0..21).map(|_| json!({ "amount": 1 })).collect();
        assert_eq!(splits(Json::Array(many)), Err("A recurring can have at most 20 splits".into()));
        let twenty: Vec<Json> = (0..20).map(|_| json!({ "amount": 1 })).collect();
        assert_eq!(splits(Json::Array(twenty)).map(|s| s.len()), Ok(20));
    }

    #[test]
    fn each_split_is_an_object_with_a_positive_amount() {
        for item in [json!(null), json!(0), json!(""), json!(false), json!(5), json!("x"), json!(true)] {
            assert_eq!(splits(json!([item])), Err("Each split must be an object".into()));
        }
        assert_eq!(splits(json!([[]])), Err("Field amount must be an object".into()));
        assert_eq!(splits(json!([{}])), Err("Missing required field: amount".into()));
        assert_eq!(splits(json!([{ "amount": null }])), Err("Field amount must be a number".into()));
        assert_eq!(splits(json!([{ "amount": "5" }])), Err("Field amount must be a number".into()));
        assert_eq!(splits(json!([{ "amount": 0.004 }])), Err("Each split amount must be positive".into()));
        assert_eq!(splits(json!([{ "amount": -1 }])), Err("Each split amount must be positive".into()));
        assert_eq!(splits(json!([{ "amount": 1, "label": 5 }])), Err("Field label must be an object".into()));
        assert_eq!(
            splits(json!([{ "amount": 1, "label": { "budget_id": "x" } }])),
            Err("Field label.budget_id must be a uuid".into())
        );
    }

    #[test]
    fn amounts_round_to_cents_and_labels_fill_in() {
        let budget = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        assert_eq!(
            splits(json!([{ "amount": 12.345 }, { "amount": 0.005, "label": { "budget_id": budget } }, { "amount": 3, "label": null }])),
            Ok(vec![
                json!({ "amount": 12.35, "label": { "budget_id": null, "category_id": null } }),
                json!({ "amount": 0.01, "label": { "budget_id": budget, "category_id": null } }),
                json!({ "amount": 3, "label": { "budget_id": null, "category_id": null } }),
            ])
        );
    }

    #[test]
    fn the_name_is_the_merchant_name_or_else_the_description() {
        assert_eq!(name_of(&json!({ "merchant_name": "Netflix", "name": "NETFLIX.COM" })), Some("Netflix"));
        assert_eq!(name_of(&json!({ "merchant_name": "", "name": "NETFLIX.COM" })), Some("NETFLIX.COM"));
        assert_eq!(name_of(&json!({ "merchant_name": null, "name": null })), None);
    }
}
