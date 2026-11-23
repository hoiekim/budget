//! `POST /suggest-category`: `src/server/routes/accounts/post-suggest-category.ts`.
//!
//! Category suggestions written by an outside caller (an API key with the
//! `transactions:suggest` scope, or a signed-in session), never over a label
//! the user confirmed.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::js::{json_stringify, number_to_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::database::shared_with;
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::{budget, category, transaction, MaskedUser, Row, UpdateArgs};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::is_uuid;

/// The most suggestions one request may carry.
const MAX_SUGGESTIONS: usize = 500;

/// Max concurrent UPDATEs while applying a batch. The pool caps at 20
/// connections, and a 500-row batch used to pay one sequential round trip
/// per suggestion; 10 in flight leaves headroom for the rest of the request
/// and for concurrent requests.
const SUGGEST_UPDATE_CONCURRENCY: usize = 10;

const INVALID_SHAPE: &str = "Invalid shape. Required: { transaction_id: string, confidence: number in (0,1) exclusive }, with optional label_category_id and label_budget_id.";

/// What became of one suggestion.
#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Updated(String),
    Skipped(String, String),
    Error(String, String),
}

impl Outcome {
    fn to_json(&self) -> Json {
        match self {
            Outcome::Updated(id) => json!({ "transaction_id": id, "status": "updated" }),
            Outcome::Skipped(id, reason) => json!({ "transaction_id": id, "status": "skipped", "reason": reason }),
            Outcome::Error(id, reason) => json!({ "transaction_id": id, "status": "error", "reason": reason }),
        }
    }
}

/// A suggestion of the right shape. A label key that is absent is `None`;
/// one that is `null` is `Some(Json::Null)`.
#[derive(Clone, Debug)]
struct Suggestion {
    transaction_id: String,
    label_category_id: Option<Json>,
    label_budget_id: Option<Json>,
    confidence: f64,
}

/// `isNullableString`.
fn is_nullable_string(value: &Json) -> bool {
    value.is_null() || value.is_string()
}

/// The suggestion `raw` describes, when it has the required shape.
fn as_suggestion(raw: &Json) -> Option<Suggestion> {
    let Json::Object(o) = raw else { return None };
    let transaction_id = o.get("transaction_id")?.as_str()?.to_string();
    let confidence = o.get("confidence")?.as_f64()?;
    // Confidence must lie in (0, 1): 1.0 stays reserved for "user-confirmed",
    // written by the signed-in UI. Negative or above 1 is nonsense.
    if !(confidence > 0.0 && confidence < 1.0) {
        return None;
    }
    let label_category_id = o.get("label_category_id").cloned();
    let label_budget_id = o.get("label_budget_id").cloned();
    if label_category_id.as_ref().is_some_and(|id| !is_nullable_string(id)) {
        return None;
    }
    if label_budget_id.as_ref().is_some_and(|id| !is_nullable_string(id)) {
        return None;
    }
    Some(Suggestion { transaction_id, label_category_id, label_budget_id, confidence })
}

/// How the JavaScript engine names a value that was called but is not a function.
fn describe_uncallable(value: &Json) -> String {
    match value {
        Json::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(_) | Json::Bool(_) => json_stringify(value),
        Json::Array(_) => "an instance of Array".to_string(),
        _ => "an instance of Object".to_string(),
    }
}

/// `String(element)` for an element of an array being joined: an object
/// with a `toString` of its own (never a function in JSON) has no string
/// form, and the join fails.
fn element_to_string(value: &Json) -> anyhow::Result<String> {
    match value {
        Json::Null => Ok(String::new()),
        Json::Array(items) => join(items),
        Json::Object(o) if o.contains_key("toString") => anyhow::bail!("No default value"),
        Json::Object(_) => Ok("[object Object]".to_string()),
        other => Ok(crate::js::to_js_string(other)),
    }
}

/// `Array.prototype.toString`.
fn join(items: &[Json]) -> anyhow::Result<String> {
    Ok(items.iter().map(element_to_string).collect::<anyhow::Result<Vec<_>>>()?.join(","))
}

/// `raw?.transaction_id?.toString?.() ?? "<invalid>"`: the id an outcome of
/// a misshapen suggestion names. An object id with a `toString` key of its
/// own calls that value, which fails unless it is null.
fn outcome_id(raw: &Json) -> anyhow::Result<String> {
    const INVALID: &str = "<invalid>";
    let Some(id) = raw.as_object().and_then(|o| o.get("transaction_id")) else { return Ok(INVALID.to_string()) };
    match id {
        Json::Null => Ok(INVALID.to_string()),
        Json::Array(items) => join(items),
        Json::Object(o) => match o.get("toString") {
            None => Ok("[object Object]".to_string()),
            Some(Json::Null) => Ok(INVALID.to_string()),
            Some(uncallable) => anyhow::bail!(
                "raw?.transaction_id?.toString is not a function. (In 'raw?.transaction_id?.toString?.()', 'raw?.transaction_id?.toString' is {})",
                describe_uncallable(uncallable)
            ),
        },
        other => Ok(crate::js::to_js_string(other)),
    }
}

fn summarize(outcomes: &[Outcome]) -> Json {
    let (mut updated, mut skipped, mut errored) = (0, 0, 0);
    for outcome in outcomes {
        match outcome {
            Outcome::Updated(_) => updated += 1,
            Outcome::Skipped(..) => skipped += 1,
            Outcome::Error(..) => errored += 1,
        }
    }
    json!({
        "outcomes": outcomes.iter().map(Outcome::to_json).collect::<Vec<_>>(),
        "updated": updated,
        "skipped": skipped,
        "errored": errored,
    })
}

/// The distinct values, in first-seen order, of the ids that are well-formed
/// UUIDs: category_id / budget_id are UUID PRIMARY KEY columns, and a
/// non-UUID bound against them would fail the whole batch before the per-row
/// "Unknown label_*" answer could report it.
fn distinct_uuids<'a>(ids: impl Iterator<Item = Option<&'a Json>>) -> Vec<Json> {
    let mut seen = HashSet::new();
    ids.flatten().filter(|id| is_uuid(id)).filter(|id| seen.insert(id.as_str().unwrap_or_default().to_string())).cloned().collect()
}

/// The primary keys of rows read by id.
fn ids_of(rows: &[Row], primary_key: &str) -> HashSet<String> {
    rows.iter().map(|row| str_of(row, primary_key).to_string()).collect()
}

/// A suggestion that passed every check, with the columns it writes.
struct Pending {
    index: usize,
    transaction_id: String,
    updates: Obj,
}

async fn apply(user: &MaskedUser, pending: &Pending) -> (usize, Outcome) {
    let id = pending.transaction_id.clone();
    let updated = transaction::TABLE
        .update(&json!(id), &pending.updates, UpdateArgs { user_id: Some(shared_with(user)), ..Default::default() })
        .await;
    let outcome = match updated {
        Ok(Some(_)) => Outcome::Updated(id),
        Ok(None) => Outcome::Skipped(id, "Update produced no row change (concurrent modification?).".into()),
        Err(error) => {
            logger::error("suggest-category update failed", Some(&crate::ctx! { "transactionId": id }), Some(&error));
            Outcome::Error(id, "Internal error during update.".into())
        }
    };
    (pending.index, outcome)
}

async fn post_suggest_category(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let Some(Json::Array(suggestions)) = ctx.req.body.as_ref().and_then(|body| body.as_object()).and_then(|body| body.get("suggestions"))
    else {
        return Ok(ApiResponse::failed("Body must be { suggestions: [{ transaction_id, confidence, ... }] }").into());
    };
    if suggestions.is_empty() {
        return Ok(ApiResponse::success_with(json!({ "outcomes": [], "updated": 0, "skipped": 0, "errored": 0 })).into());
    }
    if suggestions.len() > MAX_SUGGESTIONS {
        return Ok(ApiResponse::failed("suggestions array must contain at most 500 entries per request").into());
    }

    let mut valid: Vec<Suggestion> = Vec::new();
    let mut outcomes: Vec<Outcome> = Vec::new();
    for raw in suggestions {
        match as_suggestion(raw) {
            Some(suggestion) => valid.push(suggestion),
            None => outcomes.push(Outcome::Error(outcome_id(raw)?, INVALID_SHAPE.to_string())),
        }
    }

    if valid.is_empty() {
        return Ok(ApiResponse::success_with(summarize(&outcomes)).into());
    }

    // Pre-fetch the rows every suggestion is checked against, in one batch
    // each: the transactions (they must exist, be within the user's sharing
    // group and not be confirmed) and the categories and budgets they name
    // (within the group too). The repository reads apply the soft-delete
    // predicate and the owner scope.
    let mut seen = HashSet::new();
    let tx_ids: Vec<Json> =
        valid.iter().filter(|s| seen.insert(s.transaction_id.clone())).map(|s| json!(s.transaction_id)).collect();
    let category_ids = distinct_uuids(valid.iter().map(|s| s.label_category_id.as_ref()));
    let budget_ids = distinct_uuids(valid.iter().map(|s| s.label_budget_id.as_ref()));

    let owner = [("user_id", shared_with(&user))];
    let (existing_txs, category_rows, budget_rows) = futures::try_join!(
        transaction::TABLE.query_by_ids(&tx_ids, &owner),
        async { if category_ids.is_empty() { Ok(Vec::new()) } else { category::TABLE.query_by_ids(&category_ids, &owner).await } },
        async { if budget_ids.is_empty() { Ok(Vec::new()) } else { budget::TABLE.query_by_ids(&budget_ids, &owner).await } },
    )?;
    let valid_category_ids = ids_of(&category_rows, "category_id");
    let valid_budget_ids = ids_of(&budget_rows, "budget_id");
    let tx_by_id: HashMap<String, &Row> = existing_txs.iter().map(|row| (str_of(row, "transaction_id").to_string(), row)).collect();

    // Check every suggestion against the pre-fetched rows first, then apply
    // the survivors in bounded-concurrency chunks. Outcomes stay in input
    // order: each slot is filled by its check or by its update.
    let mut results: Vec<Option<Outcome>> = vec![None; valid.len()];
    let mut pending: Vec<Pending> = Vec::new();
    for (index, s) in valid.iter().enumerate() {
        let id = s.transaction_id.clone();
        let Some(existing) = tx_by_id.get(&s.transaction_id) else {
            results[index] = Some(Outcome::Skipped(id, "Transaction not found or not owned by this user.".into()));
            continue;
        };
        if existing.get("label_category_confidence").and_then(Json::as_f64) == Some(1.0) {
            results[index] = Some(Outcome::Skipped(id, "Refusing to overwrite user-confirmed label (confidence = 1.0).".into()));
            continue;
        }
        let unknown = |label: &Option<Json>, known: &HashSet<String>| match label {
            Some(Json::String(label)) if !label.is_empty() && !known.contains(label) => Some(label.clone()),
            _ => None,
        };
        if let Some(category_id) = unknown(&s.label_category_id, &valid_category_ids) {
            results[index] = Some(Outcome::Error(id, format!("Unknown label_category_id: {category_id}")));
            continue;
        }
        if let Some(budget_id) = unknown(&s.label_budget_id, &valid_budget_ids) {
            results[index] = Some(Outcome::Error(id, format!("Unknown label_budget_id: {budget_id}")));
            continue;
        }
        if s.label_category_id.is_none() && s.label_budget_id.is_none() {
            results[index] = Some(Outcome::Error(id, "At least one of label_category_id / label_budget_id is required.".into()));
            continue;
        }
        let mut updates = Obj::new();
        updates.insert("label_category_confidence".into(), crate::js::num(s.confidence));
        if let Some(category_id) = &s.label_category_id {
            updates.insert("label_category_id".into(), category_id.clone());
        }
        if let Some(budget_id) = &s.label_budget_id {
            updates.insert("label_budget_id".into(), budget_id.clone());
        }
        pending.push(Pending { index, transaction_id: id, updates });
    }

    for chunk in pending.chunks(SUGGEST_UPDATE_CONCURRENCY) {
        for (index, outcome) in futures::future::join_all(chunk.iter().map(|p| apply(&user, p))).await {
            results[index] = Some(outcome);
        }
    }

    outcomes.extend(results.into_iter().flatten());

    Ok(ApiResponse::success_with(summarize(&outcomes)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/suggest-category", post_suggest_category, scope = "transactions:suggest")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggestion_needs_an_id_and_a_confidence_strictly_between_zero_and_one() {
        let valid = |raw: Json| as_suggestion(&raw).is_some();
        assert!(valid(json!({ "transaction_id": "t", "confidence": 0.5 })));
        assert!(valid(json!({ "transaction_id": "t", "confidence": 0.5, "label_category_id": null, "label_budget_id": "b" })));
        for raw in [
            json!(null),
            json!([]),
            json!("t"),
            json!({ "confidence": 0.5 }),
            json!({ "transaction_id": 5, "confidence": 0.5 }),
            json!({ "transaction_id": "t" }),
            json!({ "transaction_id": "t", "confidence": "0.5" }),
            json!({ "transaction_id": "t", "confidence": 0 }),
            json!({ "transaction_id": "t", "confidence": 1 }),
            json!({ "transaction_id": "t", "confidence": -0.5 }),
            json!({ "transaction_id": "t", "confidence": 0.5, "label_category_id": 5 }),
            json!({ "transaction_id": "t", "confidence": 0.5, "label_budget_id": {} }),
        ] {
            assert!(!valid(raw.clone()), "{raw}");
        }
    }

    #[test]
    fn a_misshapen_suggestion_is_named_by_its_id_as_text() {
        let id = |raw: Json| outcome_id(&raw).unwrap();
        assert_eq!(id(json!(null)), "<invalid>");
        assert_eq!(id(json!(5)), "<invalid>");
        assert_eq!(id(json!(["x"])), "<invalid>");
        assert_eq!(id(json!({})), "<invalid>");
        assert_eq!(id(json!({ "transaction_id": null })), "<invalid>");
        assert_eq!(id(json!({ "transaction_id": "t" })), "t");
        assert_eq!(id(json!({ "transaction_id": 1.5 })), "1.5");
        assert_eq!(id(json!({ "transaction_id": false })), "false");
        assert_eq!(id(json!({ "transaction_id": { "a": 1 } })), "[object Object]");
        assert_eq!(id(json!({ "transaction_id": { "toString": null } })), "<invalid>");
        assert_eq!(id(json!({ "transaction_id": [[1, null], { "a": 1 }, true] })), "1,,[object Object],true");
    }

    #[test]
    fn an_id_whose_to_string_is_not_a_function_fails_as_javascript_does() {
        let message = |raw: Json| outcome_id(&raw).unwrap_err().to_string();
        let prefix = "raw?.transaction_id?.toString is not a function. (In 'raw?.transaction_id?.toString?.()', 'raw?.transaction_id?.toString' is ";
        assert_eq!(message(json!({ "transaction_id": { "toString": 5 } })), format!("{prefix}5)"));
        assert_eq!(message(json!({ "transaction_id": { "toString": "x" } })), format!("{prefix}\"x\")"));
        assert_eq!(message(json!({ "transaction_id": { "toString": true } })), format!("{prefix}true)"));
        assert_eq!(message(json!({ "transaction_id": { "toString": {} } })), format!("{prefix}an instance of Object)"));
        assert_eq!(message(json!({ "transaction_id": { "toString": [1] } })), format!("{prefix}an instance of Array)"));
        assert_eq!(message(json!({ "transaction_id": [{ "toString": 1 }] })), "No default value");
    }

    #[test]
    fn the_summary_counts_each_status() {
        let outcomes = [
            Outcome::Updated("a".into()),
            Outcome::Skipped("b".into(), "r".into()),
            Outcome::Error("c".into(), "r".into()),
            Outcome::Error("d".into(), "r".into()),
        ];
        let summary = summarize(&outcomes);
        assert_eq!((summary["updated"].clone(), summary["skipped"].clone(), summary["errored"].clone()), (json!(1), json!(1), json!(2)));
        assert_eq!(summary["outcomes"][0], json!({ "transaction_id": "a", "status": "updated" }));
    }

    #[test]
    fn only_well_formed_label_ids_are_looked_up_each_once() {
        let a = json!("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
        let labels = [Some(a.clone()), Some(json!("not-a-uuid")), None, Some(Json::Null), Some(a.clone())];
        assert_eq!(distinct_uuids(labels.iter().map(Option::as_ref)), vec![a]);
    }
}
