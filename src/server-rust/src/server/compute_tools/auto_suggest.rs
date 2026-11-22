//! Category suggestions from each user's confirmed history:
//! `src/server/lib/compute-tools/auto-suggest.ts`.

use serde_json::json;

use crate::filters;
use crate::js::{num, truthy, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{shared_with_sql, AdditionalWhere, SearchFilters};
use crate::server::postgres::models::{split_transaction, transaction, user, UpdateArgs};

/// Compare-and-swap guard for both the transactions and split-transactions
/// UPDATEs. The engine must only overwrite a row that is STILL unlabeled
/// (`label_category_confidence IS NULL`), never one a user just confirmed
/// between the fetch and the per-row apply. Both apply sites thread this one
/// definition, and tests assert it.
pub fn cas_null_confidence() -> AdditionalWhere {
    AdditionalWhere::new("label_category_confidence", Json::Null)
}

/// pg_trgm similarity threshold for `merchant_name` / `name` matching.
/// 0.5 is a balanced default for short, dirty Plaid identifiers.
const TEXT_SIMILARITY_THRESHOLD: f64 = 0.5;

/// Tolerance on the amount band: matches historical transactions whose
/// amount lies in (target * 0.8, target * 1.2). Sign-preserving: a negative
/// target only matches negative historicals in the same band.
const AMOUNT_BAND_TOLERANCE: f64 = 0.2;

/// ±3 days around the target's day of month. Captures most monthly
/// recurring patterns (rent, subscriptions, paychecks) without losing every
/// match when the date falls on a weekend or holiday.
const DAY_BAND_TOLERANCE: i64 = 3;

/// Per-feature weights for the per-row scoring expression, by each feature's
/// discriminative power, tuned against the prod-clone evaluation set:
///
///   - merchant_name: 100 — uniquely identifies a merchant; the single
///     strongest signal. Most user labels are merchant-driven.
///   - name: 50 — a near-duplicate of merchant_name in most cases, but
///     informative when they diverge.
///   - plaid_pfc_primary: 10 — coarse but Plaid-curated; a strong fallback
///     when the merchant is unseen.
///   - amount band: 5 — recurring-amount patterns (rent, subscriptions) and
///     amount classes ($5 vs $500 vs $5000).
///   - payment_channel, account_id, day band: 1 — little discriminative
///     power (3 channels, ~3 accounts, ±3 days covers 20% of the month);
///     they break ties between high-merchant categories.
///
/// A row matching merchant alone (100) beats a row matching all three weak
/// features (3) by 33×: category volume cannot drown out feature quality.
const W_MERCHANT_NAME: i64 = 100;
const W_NAME: i64 = 50;
const W_PFC: i64 = 10;
const W_AMOUNT: i64 = 5;
const W_PAYMENT_CHANNEL: i64 = 1;
const W_ACCOUNT: i64 = 1;
const W_DAY: i64 = 1;

/// Minimum per-row score for a historical confirmed row to count as a
/// meaningful match: at least one identity-like signal, e.g. merchant alone
/// (100), name alone (50), or PFC + amount + a weak feature (16). Rows that
/// ONLY matched the weak trio (amount + channel + day = 7, account only = 1)
/// are coincidences and would drown out real matches by volume.
///
/// 15 does NOT exclude every weak-only row: one matching all five
/// non-identity features (amount 5 + PFC 10 + channel 1 + account 1 + day 1)
/// scores 18 and clears it. That is deliberate, since the PFC fallback is how
/// unseen merchants get suggestions at all; `IDENTITY_SCORE_THRESHOLD` keeps
/// those rows from diluting merchant-driven suggestions (budget#1018).
pub const ROW_SCORE_THRESHOLD: i64 = 15;

/// Per-row score floor for the identity tier: only rows matching
/// `merchant_name` (100) or `name` (50) count. A row matching only the five
/// non-identity features scores at most 5 + 10 + 1 + 1 + 1 = 18, so 19 is
/// the tightest separator. The engine tries this tier first and falls back
/// to `ROW_SCORE_THRESHOLD` only when it yields no suggestion, so the PFC
/// fallback for unseen merchants is kept while a merchant with confirmed
/// history is judged on its identity matches alone (budget#1018).
pub const IDENTITY_SCORE_THRESHOLD: i64 = 19;

/// Minimum quality (average per-row score / maximum possible per row) before
/// the engine writes a suggestion: how strong the average match is, not how
/// many matches exist. A null-merchant target whose whole matching pool is
/// "name match + amount" averages ~50%; one with extensive merchant history
/// 80%+. 0.30 sits below the typical true-signal floor and above the
/// weak-coincidence ceiling.
const MIN_QUALITY: f64 = 0.30;

/// Lower bound of an engine-written confidence: a suggestion that barely
/// passes the gate ships at 0.5, a "weakly confident" signal.
const ENGINE_CONFIDENCE_FLOOR: f64 = 0.5;

/// Upper bound of an engine-written confidence: below the 0.99 reserved for
/// `/api/suggest-category` callers and well below the 1.0 of a user-confirmed
/// label. A perfect-match signal ships at 0.98.
const ENGINE_CONFIDENCE_CEIL: f64 = 0.98;

/// A target transaction's features, extracted for the per-row scoring SQL.
/// A feature that is null doesn't contribute, so a target with no
/// `merchant_name` (some SimpleFin or manual rows) still scores on the other six.
#[derive(Clone, Debug, PartialEq)]
pub struct TargetFeatures {
    pub merchant_name: Json,
    pub name: Json,
    pub amount: f64,
    /// Lower bound of the amount band (sign-preserving).
    pub amount_lo: f64,
    /// Upper bound of the amount band (sign-preserving).
    pub amount_hi: f64,
    pub payment_channel: Json,
    pub account_id: Json,
    /// Plaid's `personal_finance_category.primary` from `transactions.raw`;
    /// null when the row came from SimpleFin or a manual entry.
    pub plaid_pfc_primary: Json,
    /// Day-of-month band. The lower bound may be below 1: `EXTRACT(DAY …)`
    /// only ever returns 1 to 31.
    pub day_lo: i64,
    pub day_hi: i64,
}

/// The best category for a target, and the numbers its gates judge.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureSignal {
    pub label_category_id: Json,
    /// The budget of the category's section, written as the label's budget
    /// too: the client's category picker lists the categories of the row's
    /// budget, and a category outside it would render blank.
    pub label_budget_id: Json,
    /// Sum of the per-row scores of the confirmed rows in the winning
    /// category that cleared the tier's threshold.
    pub accepted: f64,
    /// The same sum over the category's rejections (`rejected_categories` ⋈
    /// `transactions`), so the accept/reject gate compares two numbers from
    /// one formula.
    pub rejected: f64,
    /// How many confirmed rows cleared the threshold in the winning category.
    pub count_matched: f64,
    /// The highest per-row score the target could receive: the weights of
    /// the features it has. The quality metric divides `accepted` by
    /// `count_matched × max_per_row`, so it measures average match strength
    /// whatever the category's volume.
    pub max_per_row: f64,
}

/// `value ?? null`.
fn or_null(value: Option<&Json>) -> Json {
    value.cloned().unwrap_or(Json::Null)
}

/// A property of a value that may not be an object: `undefined` (`None`) unless it is one.
fn prop<'a>(value: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    value.and_then(Json::as_object).and_then(|object| object.get(key))
}

/// `value || {}`: the value when truthy.
fn truthy_value(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| truthy(value))
}

pub fn features_from_row(row: &Obj) -> TargetFeatures {
    let amount = match row.get("amount") {
        None | Some(Json::Null) => 0.0,
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
    };
    let lo = amount * (1.0 - AMOUNT_BAND_TOLERANCE);
    let hi = amount * (1.0 + AMOUNT_BAND_TOLERANCE);
    let date = match row.get("date") {
        None | Some(Json::Null) => JsDate::now(),
        Some(value) => JsDate::from_json(value),
    };
    let day = date.get_utc_date();
    let raw = truthy_value(row.get("raw"));
    let pfc = truthy_value(prop(raw, "personal_finance_category"));
    TargetFeatures {
        merchant_name: or_null(row.get("merchant_name")),
        name: or_null(row.get("name")),
        amount,
        amount_lo: lo.min(hi),
        amount_hi: lo.max(hi),
        payment_channel: or_null(row.get("payment_channel")),
        account_id: or_null(row.get("account_id")),
        plaid_pfc_primary: or_null(prop(pfc, "primary")),
        day_lo: day - DAY_BAND_TOLERANCE,
        day_hi: day + DAY_BAND_TOLERANCE,
    }
}

/// Sums the weights of the features the target has. A null feature can
/// never match, so its weight can never contribute: the quality denominator
/// leaves it out to keep the metric in [0, 1].
pub fn max_per_row_for(f: &TargetFeatures) -> f64 {
    let mut max = W_AMOUNT + W_ACCOUNT + W_DAY; // always-present features
    if truthy(&f.merchant_name) {
        max += W_MERCHANT_NAME;
    }
    if truthy(&f.name) {
        max += W_NAME;
    }
    if truthy(&f.payment_channel) {
        max += W_PAYMENT_CHANNEL;
    }
    if truthy(&f.plaid_pfc_primary) {
        max += W_PFC;
    }
    max as f64
}

struct UnlabeledTarget {
    id: String,
    features: TargetFeatures,
}

async fn fetch_unlabeled(user_id: &str) -> anyhow::Result<Vec<UnlabeledTarget>> {
    let rows = transaction::TABLE
        .query(filters! { "user_id" => user_id, "label_category_confidence" => Json::Null }, SearchFilters::default(), None)
        .await?;
    let now = JsDate::now();
    let one_week_ago = now.set_date(now.get_date() - 7);
    Ok(rows
        .iter()
        .filter(|row| JsDate::from_json(&or_null(row.get("date"))).get_time() > one_week_ago.get_time())
        .map(|row| UnlabeledTarget {
            id: row.get("transaction_id").and_then(Json::as_str).unwrap_or_default().to_string(),
            features: features_from_row(row),
        })
        .collect())
}

/// The label columns a suggestion writes.
fn label_update(label_category_id: &Json, label_budget_id: &Json, confidence: f64) -> Obj {
    let mut data = Obj::new();
    data.insert("label_category_id".into(), label_category_id.clone());
    data.insert("label_budget_id".into(), label_budget_id.clone());
    data.insert("label_category_confidence".into(), num(confidence));
    data
}

// Compare-and-swap: the UPDATE only matches rows that are STILL unlabeled
// (`label_category_confidence IS NULL`). Between the unlabeled fetch and this
// per-row call, a user may have confirmed the row in the UI (writing
// `confidence = 1`). Without the guard the engine would overwrite that
// confirmation with its own sub-1.0 suggestion and replace the user's chosen
// category and budget with the engine's pick.
async fn apply_label(transaction_id: &str, user_id: &str, signal: &FeatureSignal, confidence: f64) -> anyhow::Result<()> {
    let data = label_update(&signal.label_category_id, &signal.label_budget_id, confidence);
    let guard = [cas_null_confidence()];
    transaction::TABLE
        .update(&json!(transaction_id), &data, UpdateArgs { user_id: Some(user_id.into()), extra_where: &guard, ..Default::default() })
        .await?;
    Ok(())
}

const UNLABELED_SPLITS_SQL: &str = "SELECT st.split_transaction_id,
            t.merchant_name, t.name, t.amount, t.payment_channel, t.account_id,
            t.raw, t.date
       FROM split_transactions st
       JOIN transactions t
         ON t.transaction_id = st.transaction_id
        AND t.user_id = st.user_id
      WHERE st.user_id = $1
        AND st.label_category_confidence IS NULL
        AND (st.is_deleted IS NULL OR st.is_deleted = FALSE)
        AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
        AND t.date > NOW() - INTERVAL '1 week'";

// Splits have no merchant, name, amount or channel of their own: they take
// every feature from their parent transaction, the way a user thinks of a
// split's category.
async fn fetch_unlabeled_splits(user_id: &str) -> anyhow::Result<Vec<UnlabeledTarget>> {
    let result = pool().query(UNLABELED_SPLITS_SQL, &[json!(user_id)]).await?;
    Ok(result
        .rows
        .iter()
        .map(|row| UnlabeledTarget {
            id: row.get("split_transaction_id").and_then(Json::as_str).unwrap_or_default().to_string(),
            features: features_from_row(row),
        })
        .collect())
}

// The same guard as `apply_label`: a split a user confirmed between the
// fetch and the apply keeps their label.
async fn apply_label_to_split(split_transaction_id: &str, user_id: &str, signal: &FeatureSignal, confidence: f64) -> anyhow::Result<()> {
    let data = label_update(&signal.label_category_id, &signal.label_budget_id, confidence);
    let guard = [cas_null_confidence()];
    split_transaction::TABLE
        .update(
            &json!(split_transaction_id),
            &data,
            UpdateArgs { user_id: Some(user_id.into()), extra_where: &guard, ..Default::default() },
        )
        .await?;
    Ok(())
}

/// Runs auto-suggestion for transaction categories from historical
/// multi-feature patterns.
///
/// - For each user, find the transactions with no category confidence
///   (never labeled) in the last 7 days.
/// - For each, score the user's confirmed history on seven features
///   (merchant_name fuzzy, name fuzzy, amount band, payment_channel,
///   account_id, Plaid `personal_finance_category` primary, day-of-month
///   band), each row's score the weighted sum of the features it matches.
/// - Only rows whose score clears the tier's threshold contribute;
///   SUM(score) per category picks the winner.
/// - Two tiers per target (budget#1018): the identity tier counts only rows
///   matching `merchant_name` or `name`; only when it yields no suggestion
///   does the engine fall back to the standard tier, which admits the
///   Plaid-PFC fallback for merchants with no history.
/// - The suggestion is applied when all three gates pass: `count_matched >=
///   3` (sample size), `rejected / (accepted + rejected) <= 0.1` (reject
///   rate), `accepted / (count_matched × max_per_row) >= MIN_QUALITY` (match
///   strength). The stored confidence is that quality, clamped to
///   [ENGINE_CONFIDENCE_FLOOR, ENGINE_CONFIDENCE_CEIL] = [0.5, 0.98].
///
/// Direct SQL is reserved for the feature-signal query, which uses pg_trgm
/// `similarity(...)` and reads `transactions` and `rejected_categories`
/// together, which the generic table statements cannot express.
pub async fn run_auto_suggestions() -> anyhow::Result<()> {
    logger::info("Auto-suggestion job started", None);

    let mut total_users_processed: u64 = 0;
    let mut total_suggested: u64 = 0;

    match user::TABLE.query(filters! {}, SearchFilters::default(), None).await {
        Ok(users) => {
            let user_ids: Vec<String> =
                users.iter().map(|user| user.get("user_id").and_then(Json::as_str).unwrap_or_default().to_string()).collect();
            for user_id in user_ids {
                match process_user_suggestions(&user_id).await {
                    Ok(suggested) => {
                        total_suggested += suggested;
                        total_users_processed += 1;
                    }
                    Err(error) => {
                        logger::error("Auto-suggestion failed for user", Some(&crate::ctx! { "userId": user_id }), Some(&error))
                    }
                }
            }
        }
        Err(error) => logger::error("Auto-suggestion job failed to fetch users", Some(&Obj::new()), Some(&error)),
    }

    logger::info(
        "Auto-suggestion job completed",
        Some(&crate::ctx! { "usersProcessed": total_users_processed, "transactionsSuggested": total_suggested }),
    );
    Ok(())
}

/// Judges a signal by three gates:
///   1. Count: at least 3 confirmed rows in the winning category.
///   2. Reject rate: weighted rejections at most 10% of accepted + rejected.
///   3. Quality: the average per-row score at least `MIN_QUALITY` of the
///      maximum, guarding against weak-feature coincidences.
///
/// When all three pass, the confidence to store: the quality clamped to
/// [ENGINE_CONFIDENCE_FLOOR, ENGINE_CONFIDENCE_CEIL], so engine writes stay
/// below the 0.99 API reservation and the 1.0 of a user confirmation.
pub fn evaluate_signal(signal: &FeatureSignal) -> Option<f64> {
    if signal.count_matched < 3.0 {
        return None;
    }
    let total_labeled = signal.accepted + signal.rejected;
    if total_labeled > 0.0 && signal.rejected / total_labeled > 0.1 {
        return None;
    }
    let quality = signal.accepted / (signal.count_matched * signal.max_per_row);
    if quality < MIN_QUALITY {
        return None;
    }
    Some(ENGINE_CONFIDENCE_FLOOR.max(ENGINE_CONFIDENCE_CEIL.min(quality)))
}

#[derive(Clone, Copy)]
enum Target<'a> {
    Transaction(&'a str),
    Split(&'a str),
}

async fn process_user_suggestions(user_id: &str) -> anyhow::Result<u64> {
    let mut suggested: u64 = 0;

    // One signal query per unlabeled target. The signal depends on the whole
    // feature set (two unlabeled transactions with the same merchant but
    // different amounts or channels get different signals), so a
    // per-merchant cache would predict wrongly. The 7-day window bounds the pool.

    // Pass 1: top-level transactions.
    for target in fetch_unlabeled(user_id).await? {
        if try_suggest(user_id, &target.features, Target::Transaction(&target.id)).await? {
            suggested += 1;
        }
    }

    // Pass 2: split transactions.
    for target in fetch_unlabeled_splits(user_id).await? {
        if try_suggest(user_id, &target.features, Target::Split(&target.id)).await? {
            suggested += 1;
        }
    }

    if suggested > 0 {
        logger::info("Auto-suggested categories for user", Some(&crate::ctx! { "userId": user_id, "suggested": suggested }));
    }

    Ok(suggested)
}

/// Tries to suggest a category for one unlabeled target, identity tier
/// first, standard tier as the fallback; true when a suggestion was applied.
///
/// The fallback runs whenever the identity tier yields no applicable
/// suggestion (no signal, or a signal that fails a gate), so anything the
/// standard tier suggests on its own, the engine still suggests.
async fn try_suggest(user_id: &str, features: &TargetFeatures, target: Target<'_>) -> anyhow::Result<bool> {
    for threshold in [IDENTITY_SCORE_THRESHOLD, ROW_SCORE_THRESHOLD] {
        let Some(signal) = get_feature_signal(user_id, features, threshold).await? else { continue };
        let Some(capped_confidence) = evaluate_signal(&signal) else { continue };
        match target {
            Target::Transaction(id) => apply_label(id, user_id, &signal, capped_confidence).await?,
            Target::Split(id) => apply_label_to_split(id, user_id, &signal, capped_confidence).await?,
        }
        return Ok(true);
    }
    Ok(false)
}

/// The per-row score of the `transactions` row aliased `t`: each feature
/// adds its weight when it matches the target. Weighted multi-feature
/// agreement amplifies naturally: merchant + name + amount is 155, the weak
/// trio (channel + account + day) 3. Parameter numbers follow
/// [`signal_params`].
///
/// The three identity-like features (merchant, name, PFC) also require
/// `SIGN(amount) = SIGN(target amount)`: the same merchant with the opposite
/// sign (a refund against a purchase, a payout against a payment) is much
/// more likely a different category. The amount band is sign-preserving
/// already, and the weak tiebreakers need no gate. A target amount of 0 is
/// sign-undefined, and `SIGN($13::numeric) = 0` lets the identity features
/// match historicals of either sign.
pub fn score_expr(t: &str) -> String {
    format!(
        "(
  (CASE WHEN $2::text IS NOT NULL AND {t}.merchant_name IS NOT NULL
        AND similarity({t}.merchant_name, $2) >= $3
        AND (SIGN($13::numeric) = 0 OR SIGN({t}.amount) = SIGN($13::numeric)) THEN {W_MERCHANT_NAME} ELSE 0 END)
+ (CASE WHEN $4::text IS NOT NULL AND {t}.name IS NOT NULL
        AND similarity({t}.name, $4) >= $3
        AND (SIGN($13::numeric) = 0 OR SIGN({t}.amount) = SIGN($13::numeric)) THEN {W_NAME} ELSE 0 END)
+ (CASE WHEN {t}.amount BETWEEN $5 AND $6 THEN {W_AMOUNT} ELSE 0 END)
+ (CASE WHEN $7::text IS NOT NULL AND {t}.payment_channel = $7 THEN {W_PAYMENT_CHANNEL} ELSE 0 END)
+ (CASE WHEN {t}.account_id = $8 THEN {W_ACCOUNT} ELSE 0 END)
+ (CASE WHEN $9::text IS NOT NULL
        AND ({t}.raw->'personal_finance_category'->>'primary') = $9
        AND (SIGN($13::numeric) = 0 OR SIGN({t}.amount) = SIGN($13::numeric)) THEN {W_PFC} ELSE 0 END)
+ (CASE WHEN EXTRACT(DAY FROM {t}.date::date) BETWEEN $10 AND $11 THEN {W_DAY} ELSE 0 END)
)"
    )
}

/// Per-row score = weighted sum of feature matches; SUM(score) per category,
/// the winner the highest total. The same expression scores
/// (rejected_categories ⋈ transactions), so the accept/reject gate compares
/// two numbers from one formula.
pub fn feature_signal_sql() -> String {
    let score = score_expr("t");
    format!(
        "WITH scored AS (
       SELECT t.label_category_id,
              {score} AS score
       FROM transactions t
       WHERE t.user_id = $1
         AND t.label_category_confidence = 1.0
         AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
     ),
     winning AS (
       SELECT label_category_id,
              SUM(score)::int AS accepted,
              COUNT(*)::int AS count_matched
       FROM scored
       WHERE score > $12
       GROUP BY label_category_id
       ORDER BY accepted DESC
       LIMIT 1
     )
     SELECT
       w.label_category_id,
       sections.budget_id AS label_budget_id,
       w.accepted,
       w.count_matched,
       (
         SELECT COALESCE(SUM({score})::int, 0)
         FROM rejected_categories rc
         JOIN transactions t
           ON t.transaction_id = rc.transaction_id
           AND t.user_id = rc.user_id
         WHERE rc.user_id = $1
           AND rc.category_id = w.label_category_id
           AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
           AND {score} > $12
       ) AS rejected
     FROM winning w
     -- Scoped to the user and whoever shares data with them: a label can name anyone's
     -- category, and joining it unscoped would read a stranger's section.
     JOIN categories ON categories.category_id = w.label_category_id
       AND {}
     JOIN sections ON sections.section_id = categories.section_id
       AND {}
     LIMIT 1",
        shared_with_sql("categories.user_id", "$1"),
        shared_with_sql("sections.user_id", "$1"),
    )
}

/// The feature-signal query's parameters, `$1` to `$13`.
pub fn signal_params(user_id: &str, f: &TargetFeatures, row_score_threshold: i64) -> Vec<Json> {
    vec![
        json!(user_id),                     // $1
        f.merchant_name.clone(),            // $2 (or null)
        num(TEXT_SIMILARITY_THRESHOLD),     // $3
        f.name.clone(),                     // $4 (or null)
        num(f.amount_lo),                   // $5
        num(f.amount_hi),                   // $6
        f.payment_channel.clone(),          // $7 (or null)
        f.account_id.clone(),               // $8
        f.plaid_pfc_primary.clone(),        // $9 (or null)
        json!(f.day_lo),                    // $10
        json!(f.day_hi),                    // $11
        json!(row_score_threshold),         // $12: the per-row score floor of this tier
        num(f.amount),                      // $13: the sign source of the identity features' gates
    ]
}

/// `Number(value)` of a column the query casts to `int`.
fn number_of(row: &Obj, column: &str) -> f64 {
    match row.get(column) {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
    }
}

async fn get_feature_signal(user_id: &str, f: &TargetFeatures, row_score_threshold: i64) -> anyhow::Result<Option<FeatureSignal>> {
    let result = pool().query(&feature_signal_sql(), &signal_params(user_id, f, row_score_threshold)).await?;
    let Some(row) = result.rows.first() else { return Ok(None) };
    Ok(Some(FeatureSignal {
        label_category_id: or_null(row.get("label_category_id")),
        label_budget_id: or_null(row.get("label_budget_id")),
        accepted: number_of(row, "accepted"),
        rejected: number_of(row, "rejected"),
        count_matched: number_of(row, "count_matched"),
        max_per_row: max_per_row_for(f),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::math_round;
    use crate::server::postgres::database::{build_update, UpdateOptions};

    /// `Math.round(value * 100) / 100`, to compare confidences.
    fn cents(value: f64) -> f64 {
        math_round(value * 100.0) / 100.0
    }

    fn obj(value: Json) -> Obj {
        value.as_object().cloned().unwrap_or_default()
    }

    /// The default target of the TypeScript tests: merchant "Coffee Shop",
    /// amount 5, no name, channel or PFC, so `max_per_row` is
    /// 5 + 1 + 1 + 100 = 107.
    fn coffee() -> TargetFeatures {
        features_from_row(&obj(json!({
            "transaction_id": "txn-1",
            "account_id": "acc-1",
            "name": null,
            "merchant_name": "Coffee Shop",
            "amount": 5,
            "date": "2026-11-15",
            "payment_channel": null,
            "raw": null,
        })))
    }

    fn signal(accepted: f64, count_matched: f64, rejected: f64) -> FeatureSignal {
        FeatureSignal {
            label_category_id: json!("cat-1"),
            label_budget_id: json!("bud-1"),
            accepted,
            rejected,
            count_matched,
            max_per_row: max_per_row_for(&coffee()),
        }
    }

    fn collapsed(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    // "runAutoSuggestions" gates

    #[test]
    fn fewer_than_three_matches_is_too_small_a_sample() {
        assert_eq!(evaluate_signal(&signal(200.0, 2.0, 0.0)), None);
    }

    #[test]
    fn a_reject_rate_above_a_tenth_blocks_the_suggestion() {
        assert_eq!(evaluate_signal(&signal(800.0, 8.0, 200.0)), None);
        // Exactly a tenth still passes.
        assert!(evaluate_signal(&signal(900.0, 9.0, 100.0)).is_some());
    }

    #[test]
    fn a_quality_below_the_minimum_blocks_the_suggestion() {
        // 30 / (3 × 107) ≈ 0.093.
        assert_eq!(evaluate_signal(&signal(30.0, 3.0, 0.0)), None);
    }

    #[test]
    fn the_confidence_is_the_quality_clamped_to_its_band() {
        // 750 / (10 × 107) ≈ 0.70.
        assert_eq!(evaluate_signal(&signal(750.0, 10.0, 0.0)).map(cents), Some(0.7));
        // A perfect match is capped at 0.98.
        assert_eq!(evaluate_signal(&signal(1070.0, 10.0, 0.0)), Some(0.98));
        // A borderline quality (≈ 0.31) ships at the 0.5 floor.
        assert_eq!(evaluate_signal(&signal(100.0, 3.0, 0.0)), Some(0.5));
    }

    #[test]
    fn the_identity_threshold_sits_above_the_weak_only_maximum() {
        let weak_max = W_AMOUNT + W_PFC + W_PAYMENT_CHANNEL + W_ACCOUNT + W_DAY;
        assert_eq!(weak_max, 18);
        assert!(IDENTITY_SCORE_THRESHOLD > weak_max);
        const { assert!(IDENTITY_SCORE_THRESHOLD < W_NAME) };
        const { assert!(ROW_SCORE_THRESHOLD < IDENTITY_SCORE_THRESHOLD) };
    }

    // Features

    #[test]
    fn features_come_from_the_row_with_bands_around_the_amount_and_the_day() {
        let f = features_from_row(&obj(json!({
            "transaction_id": "t",
            "account_id": "acc-1",
            "name": "SQ *COFFEE",
            "merchant_name": "Coffee",
            "amount": -10,
            "date": "2026-03-02",
            "payment_channel": "in store",
            "raw": { "personal_finance_category": { "primary": "FOOD_AND_DRINK" } },
        })));
        assert_eq!(
            f,
            TargetFeatures {
                merchant_name: json!("Coffee"),
                name: json!("SQ *COFFEE"),
                amount: -10.0,
                amount_lo: -12.0,
                amount_hi: -8.0,
                payment_channel: json!("in store"),
                account_id: json!("acc-1"),
                plaid_pfc_primary: json!("FOOD_AND_DRINK"),
                day_lo: -1,
                day_hi: 5,
            }
        );
        assert_eq!(max_per_row_for(&f), 168.0);
    }

    #[test]
    fn a_missing_amount_or_category_reads_as_zero_and_null() {
        for raw in [json!(null), json!("text"), json!([]), json!({}), json!({ "personal_finance_category": "x" })] {
            let f = features_from_row(&obj(json!({ "account_id": "a", "amount": null, "date": "2026-03-31", "raw": raw })));
            assert_eq!((f.amount, f.amount_lo, f.amount_hi, f.plaid_pfc_primary.clone()), (0.0, 0.0, 0.0, Json::Null));
            assert_eq!((f.day_lo, f.day_hi), (28, 34));
            assert_eq!(max_per_row_for(&f), 7.0);
        }
    }

    // "CAS guard"

    #[test]
    fn the_guard_renders_is_null_in_the_update() {
        let guard = cas_null_confidence();
        assert_eq!(guard.column, "label_category_confidence");
        let additional_where = [AdditionalWhere::new("user_id", "u-1"), guard];
        let data = label_update(&json!("cat-1"), &json!("bud-1"), 0.7);
        let query = build_update(
            "transactions",
            "transaction_id",
            &json!("txn-1"),
            &data,
            &UpdateOptions { additional_where: &additional_where, returning: &["transaction_id"], exclude_deleted: true },
        )
        .unwrap();
        assert!(query.sql.contains("AND label_category_confidence IS NULL"), "{}", query.sql);
        assert!(query.sql.contains("user_id = $"), "{}", query.sql);
        assert!(!query.values.iter().any(Json::is_null));
    }

    // "feature signal SQL shape"

    #[test]
    fn accepted_rows_are_the_confirmed_live_ones() {
        let sql = collapsed(&feature_signal_sql());
        assert!(sql.contains("FROM transactions t WHERE t.user_id = $1 AND t.label_category_confidence = 1.0 AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)"));
    }

    #[test]
    fn rejected_rows_are_the_category_rejections_joined_to_live_transactions() {
        let sql = collapsed(&feature_signal_sql());
        assert!(sql.contains("FROM rejected_categories rc JOIN transactions t ON t.transaction_id = rc.transaction_id AND t.user_id = rc.user_id WHERE rc.user_id = $1 AND rc.category_id = w.label_category_id AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)"));
    }

    #[test]
    fn the_score_sums_seven_weighted_features_in_both_subqueries() {
        let score = score_expr("t");
        for weight in ["THEN 100 ELSE 0", "THEN 50 ELSE 0", "THEN 10 ELSE 0", "THEN 5 ELSE 0"] {
            assert_eq!(score.matches(weight).count(), 1, "{weight}");
        }
        assert_eq!(score.matches("THEN 1 ELSE 0").count(), 3);
        assert_eq!(score.matches("SIGN($13::numeric) = 0 OR SIGN(t.amount) = SIGN($13::numeric)").count(), 3);
        // Accepted, the rejected sum, and the rejected threshold.
        assert_eq!(feature_signal_sql().matches(&score).count(), 3);
    }

    #[test]
    fn the_winner_is_the_highest_sum_over_the_tier_threshold() {
        let sql = collapsed(&feature_signal_sql());
        assert!(sql.contains("SUM(score)::int AS accepted, COUNT(*)::int AS count_matched FROM scored WHERE score > $12 GROUP BY label_category_id ORDER BY accepted DESC LIMIT 1"));
    }

    #[test]
    fn the_category_and_section_joins_are_scoped_to_the_sharing_group() {
        let sql = collapsed(&feature_signal_sql());
        assert!(sql.contains(
            "JOIN categories ON categories.category_id = w.label_category_id AND categories.user_id = ANY(sharing_user_ids($1)) JOIN sections"
        ));
        assert!(sql.contains(
            "JOIN sections ON sections.section_id = categories.section_id AND sections.user_id = ANY(sharing_user_ids($1)) LIMIT 1"
        ));
    }

    #[test]
    fn optional_features_short_circuit_on_a_null_target_value() {
        let score = score_expr("t");
        for guard in ["$2::text IS NOT NULL", "$4::text IS NOT NULL", "$7::text IS NOT NULL", "$9::text IS NOT NULL"] {
            assert!(score.contains(guard), "{guard}");
        }
    }

    #[test]
    fn the_params_carry_the_target_features_in_slot_order() {
        let params = signal_params("user-1", &coffee(), IDENTITY_SCORE_THRESHOLD);
        let expected = vec![
            json!("user-1"),
            json!("Coffee Shop"),
            json!(0.5),
            Json::Null,
            json!(4),
            json!(6),
            Json::Null,
            json!("acc-1"),
            Json::Null,
            json!(12),
            json!(18),
            json!(19),
            json!(5),
        ];
        assert_eq!(params, expected);
        assert_eq!(signal_params("user-1", &coffee(), ROW_SCORE_THRESHOLD)[11], json!(15));
    }

    #[test]
    fn the_split_fetch_takes_its_features_from_the_live_parent_of_the_last_week() {
        let sql = collapsed(UNLABELED_SPLITS_SQL);
        assert!(sql.contains("JOIN transactions t ON t.transaction_id = st.transaction_id AND t.user_id = st.user_id"));
        assert!(sql.contains("st.label_category_confidence IS NULL"));
        assert!(sql.contains("AND t.date > NOW() - INTERVAL '1 week'"));
    }
}
