//! `src/common/plan-statement/preview.ts`.
//!
//! The JSON objects, with the TypeScript's keys:
//!
//! - `PlanStatementHolding`, a holding's position after the import, for its
//!   holdings row: `{ security_id, date, quantity, cost_basis, price }`.
//! - `PlanStatementImportRequest`, what the import page sends:
//!   `{ account_id, transactions, mappings, replace, holdings }`. `mappings`
//!   are the statement's funds (`PlanFundMapping`s,
//!   `{ investment, security_id, restated }`), saved on the account so the
//!   next statement opens with them filled in; `replace` the securities whose
//!   entered positions are retired, so the holding follows the transactions
//!   alone.
//! - `PlanStatementImportResult`: `{ written, alreadyImported, deleted? }`.
//! - `RestatementCloses`: `{ bars }` or `{ message, retryable? }`.
//! - `PlannedReinvestment`, a dividend reinvestment the import infers for a
//!   restated holding: `{ investment, ex_date, amount, quantity, topUp }`.
//! - `HeldMovement`: a `Movement` with its `subtype`.
//! - `AccountRow`: an investment transaction's `investment_transaction_id` and `date`.

use anyhow::bail;
use indexmap::{IndexMap, IndexSet};

use super::parse::parse_plan_statement;
use super::plan::{plan_import, PlanSource, Planned};
use super::reinvest::{get_reinvestment_id, plan_reinvestments_of, Reinvestments, INFERRED_DIVIDEND_ID_PREFIX};
use crate::common::holding_positions::value::{
    compare_text, gt, is_text, join_text, lt, sort_default, text, to_text, Key, Literal,
};
use crate::common::holding_positions::{derive_positions_of, is_derived_position_transaction_id, DerivedPositions, Movement};
use crate::js::{self, JsDate, Json};

/// Days of closes before a restated fund's first row, so a row dated on a holiday finds the prior close.
pub const CLOSES_LEAD_DAYS: i64 = 10;

/// `InvestmentTransactionSubtype.DividendReinvestment`.
const DIVIDEND_REINVESTMENT: &str = "dividend reinvestment";

/// The day `days` after a `YYYY-MM-DD`. A date that cannot be read is an
/// error, as `toISOString()` throws on one.
fn shift_date(date: Option<&Json>, days: i64) -> anyhow::Result<String> {
    let day = JsDate::parse(&format!("{}T00:00:00Z", to_text(date)));
    let shifted = JsDate::from_ms(day.get_time() + days as f64 * 86_400_000.0);
    match shifted.to_iso_string() {
        Some(iso) => Ok(js::js_slice_start(&iso, 10)),
        None => bail!("{} is not a date", to_text(date)),
    }
}

/// The days of the account's plan-statement rows, in the account's order.
fn plan_statement_days(account_rows: &[Json]) -> anyhow::Result<Vec<String>> {
    let mut days = Vec::new();
    for row in account_rows {
        let id = text(row.get("investment_transaction_id"), "an account row's investment_transaction_id")?;
        if is_derived_position_transaction_id(id) {
            days.push(js::js_slice_start(text(row.get("date"), "an account row's date")?, 10));
        }
    }
    Ok(days)
}

/// `inferencePeriod`'s answer: the day it starts after, if any, and its last day as the last row gives it.
fn period(rows: &[Json], account_rows: &[Json]) -> anyhow::Result<(Option<String>, Option<Json>)> {
    let (Some(first_row), Some(last_row)) = (rows.first(), rows.last()) else { bail!("a statement with no rows has no period") };
    let first = first_row.get("date");
    let mut after: Option<String> = None;
    for row in account_rows {
        if !is_derived_position_transaction_id(text(row.get("investment_transaction_id"), "an account row's investment_transaction_id")?) {
            continue;
        }
        let day = js::js_slice_start(text(row.get("date"), "an account row's date")?, 10);
        let before_first = lt(Some(&Json::String(day.clone())), first);
        if before_first && after.as_ref().is_none_or(|after| compare_text(&day, after).is_gt()) {
            after = Some(day);
        }
    }
    Ok((after, last_row.get("date").cloned()))
}

/// The ex-dates a statement infers payouts for: after the latest plan-statement row before it (where
/// an earlier import's period ended), through its own last row. A payout between two statements
/// imported in order falls to the later one, and one an earlier import covered isn't planned again.
///
/// `rows` are `StatementRow`s, oldest first, and `account_rows` the account's
/// live transactions (`AccountRow`s). Returns `{ after, through }`, `after`
/// being `null` for none. No rows, or an account row whose id or date is not
/// a string, is an error.
pub fn inference_period(rows: &[Json], account_rows: &[Json]) -> anyhow::Result<Json> {
    let (after, through) = period(rows, account_rows)?;
    Ok(Literal::new().set("after", after.map(Json::String).unwrap_or(Json::Null)).opt("through", through).into())
}

/// The closes a restated fund needs: the statement's rows, the period whose payouts it infers, and
/// the account's later plan-statement rows, whose reinvestments may need a top-up. `{ from, to }`.
pub fn restatement_closes_range(rows: &[Json], account_rows: &[Json]) -> anyhow::Result<Json> {
    let (after, through) = period(rows, account_rows)?;
    let later = plan_statement_days(account_rows)?.into_iter().map(Json::String).filter(|day| gt(Some(day), through.as_ref()));
    let mut dates = vec![rows.first().and_then(|row| row.get("date")).cloned(), through.clone()];
    dates.extend(after.filter(|after| !after.is_empty()).map(|after| Some(Json::String(after))));
    dates.extend(later.map(Some));
    range_of(dates)
}

fn range_of(mut dates: Vec<Option<Json>>) -> anyhow::Result<Json> {
    sort_default(&mut dates);
    let from = shift_date(dates.first().and_then(Option::as_ref), -CLOSES_LEAD_DAYS)?;
    Ok(Literal::new().set("from", from).opt("to", dates.last().cloned().flatten()).into())
}

/// The range of closes a restated fund's rows need: `{ from, to }`, from
/// `CLOSES_LEAD_DAYS` before the earliest date through the latest. No dates,
/// or an earliest one that is not a date, is an error.
pub fn closes_range<S: AsRef<str>>(dates: &[S]) -> anyhow::Result<Json> {
    range_of(dates.iter().map(|date| Some(Json::String(date.as_ref().to_string()))).collect())
}

/// A mapped holding's live transactions (`HeldMovement`s) and entered
/// positions (`EnteredPosition`s), as [`PreviewInput::holding`] answers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Held {
    pub movements: Vec<Json>,
    pub entered: Vec<Json>,
}

/// What [`preview_plan_statement`] takes: the TypeScript's `PreviewInput`.
#[derive(Clone, Copy)]
pub struct PreviewInput<'a> {
    pub account_id: &'a str,
    pub iso_currency_code: &'a str,
    pub csv: &'a str,
    /// The statement's funds, and the account's restated funds it has no rows for: a `FundMapping` per fund name.
    pub mappings: &'a IndexMap<String, Json>,
    /// The `Decision` made for a row, by row id.
    pub decisions: &'a Json,
    /// A `RestatementCloses` per restated fund name.
    pub closes: &'a IndexMap<String, Json>,
    /// Live transaction ids in the account.
    pub existing_ids: &'a IndexSet<String>,
    /// Rows the import found deleted from the account, which are planned around like live ones.
    pub deleted_ids: &'a IndexSet<String>,
    /// Funds whose entered positions are replaced by the transactions' figures.
    pub replace: &'a IndexSet<String>,
    /// The account's live transactions (`AccountRow`s).
    pub account_rows: &'a [Json],
    /// A mapped holding's live transactions and entered positions, by security id.
    pub holding: &'a dyn Fn(&str) -> Held,
    /// YYYY-MM
    pub through_month: &'a str,
}

/// Everything the import page shows for a statement: the TypeScript's
/// `PlanStatementPreview`, an `ImportPlan` and what the preview adds to it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanStatementPreview {
    /// `PlannedRow`s.
    pub rows: Vec<Json>,
    /// `FundSummary`s.
    pub funds: Vec<Json>,
    /// `PlannedTransaction`s.
    pub transactions: Vec<Json>,
    /// Why the plan can't be imported yet; empty when it can.
    pub blockers: Vec<String>,
    /// Lines of the file that could not be read.
    pub parse_errors: Vec<String>,
    /// `PlannedReinvestment`s.
    pub reinvestments: Vec<Json>,
    /// A restated holding's prices are what blocks the import, so asking again may clear it.
    pub retry_closes: bool,
    /// The `PlanStatementImportRequest` that imports this preview, when nothing blocks it.
    pub request: Option<Json>,
}

impl PlanStatementPreview {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        Literal::new()
            .set("rows", self.rows.clone())
            .set("funds", self.funds.clone())
            .set("transactions", self.transactions.clone())
            .set("blockers", self.blockers.clone())
            .set("parseErrors", self.parse_errors.clone())
            .set("reinvestments", self.reinvestments.clone())
            .set("retryCloses", self.retry_closes)
            .set("request", self.request.clone().unwrap_or(Json::Null))
            .into()
    }
}

/// The TypeScript's `PlanStatementPreview | { error: string }`:
///
/// - a `PlanStatementPreview` is `Preview(preview)`
/// - `{ error }` is `Error { error }`
#[derive(Clone, Debug, PartialEq)]
pub enum PreviewOutcome {
    Preview(Box<PlanStatementPreview>),
    Error { error: String },
}

impl PreviewOutcome {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        match self {
            PreviewOutcome::Preview(preview) => preview.to_json(),
            PreviewOutcome::Error { error } => Literal::new().set("error", error.as_str()).into(),
        }
    }
}

/// A restated holding the import infers dividends for.
struct RestatedHolding<'a> {
    investments: Vec<&'a str>,
    bars: Option<&'a [Json]>,
    message: Json,
}

/// A fund mapping's property. A mapping that is `null` has none to read, which throws.
fn of_mapping<'a>(mapping: &'a Json, key: &str) -> anyhow::Result<Option<&'a Json>> {
    if mapping.is_null() {
        bail!("a fund mapping is null");
    }
    Ok(mapping.get(key))
}

/// The restated holdings the import infers dividends for, by security, since two
/// funds can be restated into one. The mappings may include the account's other
/// restated funds, which this statement has no rows for but whose shares are
/// still owed the payouts in its period.
fn restated_holdings<'a>(
    mappings: &'a IndexMap<String, Json>,
    closes: &IndexMap<&'a str, &'a [Json]>,
    close_errors: &'a IndexMap<String, Json>,
) -> anyhow::Result<IndexMap<Key, RestatedHolding<'a>>> {
    let mut holdings: IndexMap<Key, RestatedHolding> = IndexMap::new();
    for (investment, mapping) in mappings {
        if !js::truthy_opt(of_mapping(mapping, "restated")?) {
            continue;
        }
        let holding = holdings.entry(Key::of(mapping.get("security_id"))).or_insert_with(|| RestatedHolding {
            investments: Vec::new(),
            bars: None,
            message: Json::String(String::new()),
        });
        holding.investments.push(investment);
        if holding.bars.is_none() {
            holding.bars = closes.get(investment.as_str()).copied();
        }
        if !js::truthy(&holding.message) {
            let message = close_errors.get(investment).and_then(|error| error.get("message")).filter(|message| !message.is_null());
            holding.message = message.cloned().unwrap_or_else(|| {
                let ticker = mapping.get("ticker_symbol").filter(|ticker| !ticker.is_null());
                Json::String(format!("No {} prices", ticker.map(|ticker| to_text(Some(ticker))).unwrap_or_else(|| "ticker".to_string())))
            });
        }
    }
    Ok(holdings)
}

/// Securities whose entered positions are replaced, which any fund mapped to them can ask for.
fn replaced_securities(mappings: &IndexMap<String, Json>, replace: &IndexSet<String>) -> anyhow::Result<IndexSet<Key>> {
    let mut securities = IndexSet::new();
    for (investment, mapping) in mappings {
        if replace.contains(investment) {
            securities.insert(Key::of(of_mapping(mapping, "security_id")?));
        }
    }
    Ok(securities)
}

/// Whether the plan reports this holding's dividends itself, as rows the
/// statement or an earlier import wrote, so inferring them would count them twice.
fn reports_dividends(movements: &[Movement]) -> anyhow::Result<bool> {
    for movement in movements {
        if !is_text(movement.subtype.as_ref(), DIVIDEND_REINVESTMENT) {
            continue;
        }
        let id = match &movement.investment_transaction_id {
            None | Some(Json::Null) => "",
            id => text(id.as_ref(), "a movement's investment_transaction_id")?,
        };
        if !id.starts_with(INFERRED_DIVIDEND_ID_PREFIX) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Everything the import page shows for a statement, and the request that
/// imports it: the plan, each mapped holding's entered positions that the
/// transactions (after this import) don't explain, and each holding's position
/// afterwards.
///
/// The `holding` callback is asked about a mapping's `security_id` only when
/// that is a string; a mapping with anything else there holds nothing. A
/// `closes` entry that is not an object, a mapping that is `null`, or a
/// movement or account row whose id or date is not text where one is read,
/// is an error.
pub fn preview_plan_statement(input: &PreviewInput) -> anyhow::Result<PreviewOutcome> {
    let parsed = parse_plan_statement(input.csv);
    if parsed.rows.is_empty() {
        let error = parsed.errors.first().cloned().unwrap_or_else(|| "The file has no statement rows.".to_string());
        return Ok(PreviewOutcome::Error { error });
    }

    let mut closes: IndexMap<&str, &[Json]> = IndexMap::new();
    let mut close_errors: IndexMap<String, Json> = IndexMap::new();
    for (investment, result) in input.closes {
        match result {
            Json::Object(closes_or_error) if closes_or_error.contains_key("bars") => {
                // Bars that are `null` count as no bars at all, here and wherever they are looked up.
                if let Some(Json::Array(bars)) = closes_or_error.get("bars") {
                    closes.insert(investment, bars);
                }
            }
            Json::Object(_) | Json::Array(_) => {
                close_errors.insert(investment.clone(), result.clone());
            }
            other => bail!("the closes of {investment} are not an object: {}", to_text(Some(other))),
        }
    }

    let known: IndexSet<String> = input.existing_ids.iter().chain(input.deleted_ids).cloned().collect();
    let mut plan = plan_import(&PlanSource {
        account_id: input.account_id,
        iso_currency_code: input.iso_currency_code,
        rows: &parsed.rows,
        mappings: input.mappings,
        decisions: input.decisions,
        closes: closes.clone(),
        close_errors: Some(&close_errors),
        existing_ids: &known,
    })?;

    let held_by = |security_id: &Key| security_id.as_str().map(input.holding).unwrap_or_default();
    let of_security = |transactions: &[Planned], security_id: &Key| -> Vec<Movement> {
        let movements = transactions.iter().map(|planned| &planned.movement);
        movements.filter(|movement| Key::of(movement.security_id.as_ref()) == *security_id).cloned().collect()
    };

    let (after, through) = period(&parsed.rows, input.account_rows)?;
    let replacing = replaced_securities(input.mappings, input.replace)?;
    let mut reinvestments: Vec<Json> = Vec::new();
    let mut reinvested: IndexSet<Key> = IndexSet::new();
    let mut retry_closes = false;
    if plan.blockers.is_empty() {
        let writing: IndexSet<String> = plan
            .transactions
            .iter()
            .filter_map(|planned| planned.movement.investment_transaction_id.as_ref().and_then(Json::as_str))
            .map(str::to_string)
            .collect();
        // Each restated holding with something in it: what it held and what this import writes to it.
        let mut owed: Vec<(Key, Held, Vec<Movement>, RestatedHolding)> = Vec::new();
        for (security_id, holding) in restated_holdings(input.mappings, &closes, &close_errors)? {
            let held = held_by(&security_id);
            let mut movements = Movement::all(&held.movements);
            movements.extend(of_security(&plan.transactions, &security_id));
            if !movements.is_empty() {
                owed.push((security_id, held, movements, holding));
            }
        }
        for (_, _, _, holding) in &owed {
            if holding.bars.is_some() {
                continue;
            }
            plan.blockers.push(format!("{}: {}", holding.investments.join(" / "), to_text(Some(&holding.message))));
            retry_closes = true;
        }
        if plan.blockers.is_empty() {
            for (security_id, held, movements, holding) in &owed {
                if reports_dividends(movements)? {
                    continue;
                }
                let security = security_id.value();
                let planned = plan_reinvestments_of(&Reinvestments {
                    account_id: input.account_id,
                    security_id: security.as_ref(),
                    iso_currency_code: input.iso_currency_code,
                    bars: holding.bars.unwrap_or_default(),
                    after: after.as_deref(),
                    through: through.as_ref(),
                    movements,
                    writing: &writing,
                    entered: &held.entered,
                    replace: replacing.contains(security_id),
                    live_ids: input.existing_ids,
                    existing_ids: &known,
                })?;
                for Planned { movement, .. } in &planned {
                    if Key::of(movement.security_id.as_ref()) != *security_id {
                        continue;
                    }
                    reinvested.insert(security_id.clone());
                    let first_id = get_reinvestment_id(input.account_id, &join_text(security.as_ref()), &join_text(movement.date.as_ref()));
                    reinvestments.push(
                        Literal::new()
                            .set("investment", holding.investments.join(" / "))
                            .opt("ex_date", movement.date.clone())
                            .opt("amount", movement.amount.json())
                            .opt("quantity", movement.quantity.json())
                            .set("topUp", !is_text(movement.investment_transaction_id.as_ref(), &first_id))
                            .into(),
                    );
                }
                plan.transactions.extend(planned);
            }
        }
    }

    let mut holdings: Vec<Json> = Vec::new();
    let mut held_securities: IndexSet<Key> = IndexSet::new();
    let mut replace: Vec<Key> = Vec::new();
    let position_of = |security_id: &Key, replacing: bool| -> anyhow::Result<DerivedPositions> {
        let held = held_by(security_id);
        let mut movements = Movement::all(&held.movements);
        movements.extend(of_security(&plan.transactions, security_id));
        derive_positions_of(&movements, &held.entered, input.through_month, replacing)
    };
    let mut push_holding = |security_id: &Key, positions: &[Json]| {
        let Some(last) = positions.last() else { return };
        if !held_securities.insert(security_id.clone()) {
            return;
        }
        let position = last.get("position");
        holdings.push(
            Literal::new()
                .opt("security_id", security_id.value())
                .opt("date", last.get("date").cloned())
                .opt("quantity", position.and_then(|position| position.get("quantity")).cloned())
                .opt("cost_basis", position.and_then(|position| position.get("costBasis")).cloned())
                .opt("price", position.and_then(|position| position.get("price")).cloned())
                .into(),
        );
    };
    let mut funds = plan.funds.clone();
    for fund in &mut funds {
        let Some(mapping) = fund.get("mapping").filter(|mapping| js::truthy(mapping)) else { continue };
        let security_id = Key::of(mapping.get("security_id"));
        let DerivedPositions { gaps, positions } = position_of(&security_id, replacing.contains(&security_id))?;
        if !gaps.is_empty() {
            let replace_positions = replacing.contains(&security_id);
            if let Json::Object(fund) = fund {
                fund.insert("positionGaps".to_string(), Json::Array(gaps));
                fund.insert("replacePositions".to_string(), Json::Bool(replace_positions));
            }
            if replace_positions && !replace.contains(&security_id) {
                replace.push(security_id.clone());
            }
        }
        push_holding(&security_id, &positions);
    }
    for security_id in &reinvested {
        push_holding(security_id, &position_of(security_id, false)?.positions);
    }

    let transactions: Vec<Json> = plan.transactions.iter().map(|planned| planned.json.clone()).collect();
    let request = if plan.blockers.is_empty() {
        let statement_funds: IndexSet<Key> = parsed.rows.iter().map(|row| Key::of(row.get("investment"))).collect();
        let mut mappings: Vec<Json> = Vec::new();
        for (investment, mapping) in input.mappings {
            if !statement_funds.contains(&Key::text(investment)) {
                continue;
            }
            mappings.push(
                Literal::new()
                    .set("investment", investment.as_str())
                    .opt("security_id", of_mapping(mapping, "security_id")?.cloned())
                    .opt("restated", mapping.get("restated").cloned())
                    .into(),
            );
        }
        // An array writes `null` where it holds `undefined`.
        let replace: Vec<Json> = replace.iter().map(|security_id| security_id.value().unwrap_or(Json::Null)).collect();
        Some(
            Literal::new()
                .set("account_id", input.account_id)
                .set("transactions", transactions.clone())
                .set("mappings", mappings)
                .set("replace", replace)
                .set("holdings", holdings)
                .into(),
        )
    } else {
        None
    };

    Ok(PreviewOutcome::Preview(Box::new(PlanStatementPreview {
        rows: plan.rows,
        funds,
        transactions,
        blockers: plan.blockers,
        parse_errors: parsed.errors,
        reinvestments,
        retry_closes,
        request,
    })))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use serde_json::json;

    use super::*;
    use crate::common::holding_positions::value::testing::{assert_close, assert_json};
    use crate::common::plan_statement::plan::get_row_ids;

    const CSV: &str = concat!(
        "Plan name:,EXAMPLE PLAN\n",
        "Date,Investment,Transaction Type,Amount,Shares/Unit\n",
        "03/02/2026,EXAMPLE INDEX FUND,Contributions,\"100.00\",\"2.000\"\n",
        "04/01/2026,EXAMPLE INDEX FUND,Contributions,\"100.00\",\"2.000\"",
    );
    const FUND: &str = "EXAMPLE INDEX FUND";

    fn mapping(restated: bool) -> Json {
        json!({ "security_id": "sec-index", "restated": restated, "ticker_symbol": "XIDX" })
    }

    fn trust() -> Json {
        json!({ "security_id": "sec-trust", "restated": true, "ticker_symbol": "XTR" })
    }

    fn map(entries: &[(&str, Json)]) -> IndexMap<String, Json> {
        entries.iter().map(|(name, value)| (name.to_string(), value.clone())).collect()
    }

    fn ids(ids: &[&str]) -> IndexSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    /// The TypeScript tests' default input, with the parts they vary. `held` is
    /// what every security holds, as their `holding` callback answers.
    struct Case {
        csv: String,
        mappings: IndexMap<String, Json>,
        decisions: Json,
        closes: IndexMap<String, Json>,
        existing_ids: IndexSet<String>,
        deleted_ids: IndexSet<String>,
        account_rows: Vec<Json>,
        replace: IndexSet<String>,
        held: Held,
        through_month: &'static str,
    }

    impl Default for Case {
        fn default() -> Self {
            Case {
                csv: CSV.to_string(),
                mappings: map(&[(FUND, mapping(false))]),
                decisions: json!({}),
                closes: IndexMap::new(),
                existing_ids: IndexSet::new(),
                deleted_ids: IndexSet::new(),
                account_rows: Vec::new(),
                replace: IndexSet::new(),
                held: Held::default(),
                through_month: "2026-04",
            }
        }
    }

    impl Case {
        fn outcome(&self) -> PreviewOutcome {
            preview_plan_statement(&PreviewInput {
                account_id: "acct-1",
                iso_currency_code: "USD",
                csv: &self.csv,
                mappings: &self.mappings,
                decisions: &self.decisions,
                closes: &self.closes,
                existing_ids: &self.existing_ids,
                deleted_ids: &self.deleted_ids,
                replace: &self.replace,
                account_rows: &self.account_rows,
                holding: &|_| self.held.clone(),
                through_month: self.through_month,
            })
            .unwrap()
        }

        fn preview(&self) -> PlanStatementPreview {
            match self.outcome() {
                PreviewOutcome::Preview(preview) => *preview,
                PreviewOutcome::Error { error } => panic!("not a preview: {error}"),
            }
        }

        /// A statement of the default fund restated, over the bars with the 03-16 payout.
        fn restated() -> Case {
            Case { mappings: map(&[(FUND, mapping(true))]), closes: map(&[(FUND, json!({ "bars": bars() }))]), ..Default::default() }
        }
    }

    fn statuses(preview: &PlanStatementPreview) -> Vec<&str> {
        preview.rows.iter().map(|row| row["status"].as_str().unwrap()).collect()
    }

    fn request(preview: &PlanStatementPreview) -> &Json {
        preview.request.as_ref().unwrap()
    }

    fn transaction_ids(preview: &PlanStatementPreview) -> Vec<&str> {
        let transactions = request(preview)["transactions"].as_array().unwrap();
        transactions.iter().map(|t| t["transaction"]["investment_transaction_id"].as_str().unwrap()).collect()
    }

    fn row_ids() -> Vec<String> {
        get_row_ids("acct-1", &parse_plan_statement(CSV).rows).unwrap()
    }

    thread_local! {
        static PLAN_ROWS: Cell<u32> = const { Cell::new(0) };
    }

    fn plan_row(date: &str) -> Json {
        let number = PLAN_ROWS.with(|rows| {
            rows.set(rows.get() + 1);
            rows.get()
        });
        json!({ "investment_transaction_id": format!("plan-{number:0>32}"), "date": date })
    }

    fn buy_of(date: &str, quantity: f64) -> Json {
        json!({ "date": date, "type": "buy", "quantity": quantity, "amount": quantity * 50.0, "price": 50 })
    }

    fn entered(date: &str, quantity: f64) -> Json {
        json!({
            "snapshot_id": format!("holding-acct-1-sec-index-{}", date.replace('-', "")),
            "date": date,
            "quantity": quantity,
            "cost_basis": null,
            "institution_price": 50,
        })
    }

    fn held(movements: Vec<Json>, entered: Vec<Json>) -> Held {
        Held { movements, entered }
    }

    #[test]
    fn plans_the_rows_and_the_request_that_imports_them() {
        let result = Case::default().preview();
        assert_eq!(statuses(&result), ["new", "new"]);
        assert_eq!(request(&result)["transactions"].as_array().unwrap().len(), 4);
        assert_json(&request(&result)["mappings"], json!([{ "investment": FUND, "security_id": "sec-index", "restated": false }]));
        assert_json(&request(&result)["replace"], json!([]));
        assert_json(
            &request(&result)["holdings"],
            json!([{ "security_id": "sec-index", "date": "2026-04-01", "quantity": 4, "cost_basis": 200, "price": 50 }]),
        );
        let whole = result.to_json();
        let keys: Vec<&String> = whole.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["rows", "funds", "transactions", "blockers", "parseErrors", "reinvestments", "retryCloses", "request"]);
        let keys: Vec<&String> = request(&result).as_object().unwrap().keys().collect();
        assert_eq!(keys, ["account_id", "transactions", "mappings", "replace", "holdings"]);
        assert_json(&request(&result)["transactions"], Json::Array(result.transactions.clone()));
    }

    #[test]
    fn saves_only_the_mappings_of_the_statements_own_funds() {
        let other = json!({ "security_id": "sec-other", "restated": false, "ticker_symbol": "OTHR" });
        let result = Case { mappings: map(&[(FUND, mapping(false)), ("ANOTHER FUND", other)]), ..Default::default() }.preview();
        assert_json(&request(&result)["mappings"], json!([{ "investment": FUND, "security_id": "sec-index", "restated": false }]));
    }

    #[test]
    fn a_row_already_in_the_account_is_listed_as_imported_and_not_sent_again() {
        let first = row_ids().remove(0);
        let result = Case { existing_ids: ids(&[&first]), ..Default::default() }.preview();
        assert_eq!(statuses(&result), ["imported", "new"]);
        assert!(!transaction_ids(&result).contains(&first.as_str()));
    }

    #[test]
    fn an_entered_position_the_transactions_dont_explain_is_disclosed_and_kept_by_default() {
        let result = Case { held: held(Vec::new(), vec![entered("2026-01-02", 100.0)]), ..Default::default() }.preview();
        assert_json(&result.funds[0]["positionGaps"], json!([{ "date": "2026-01-02", "stored": 100, "explained": 0 }]));
        assert_json(&result.funds[0]["replacePositions"], json!(false));
        assert_json(&request(&result)["replace"], json!([]));
        assert_json(&request(&result)["holdings"][0]["quantity"], json!(104));
    }

    #[test]
    fn replacing_sends_the_security_to_retire_and_holds_only_the_transactions_shares() {
        let case = Case { replace: ids(&[FUND]), held: held(Vec::new(), vec![entered("2026-01-02", 100.0)]), ..Default::default() };
        let result = case.preview();
        assert_json(&result.funds[0]["replacePositions"], json!(true));
        assert_json(&request(&result)["replace"], json!(["sec-index"]));
        assert_json(&request(&result)["holdings"][0]["quantity"], json!(4));
    }

    #[test]
    fn an_entered_position_the_statements_own_rows_explain_isnt_a_gap() {
        let result = Case { held: held(Vec::new(), vec![entered("2026-03-02", 2.0)]), ..Default::default() }.preview();
        assert!(result.funds[0].get("positionGaps").is_none());
        assert!(result.funds[0].get("replacePositions").is_none());
    }

    #[test]
    fn the_accounts_other_transactions_on_the_holding_count_toward_its_position() {
        let movements = vec![json!({ "date": "2026-02-01", "type": "buy", "quantity": 5, "amount": 250, "price": 50 })];
        let result = Case { held: held(movements, Vec::new()), ..Default::default() }.preview();
        assert_json(&request(&result)["holdings"][0]["quantity"], json!(9));
    }

    #[test]
    fn a_blocker_leaves_no_request_to_send() {
        let result = Case { mappings: IndexMap::new(), ..Default::default() }.preview();
        assert_eq!(result.blockers, ["Map EXAMPLE INDEX FUND to a security"]);
        assert!(result.request.is_none());
        assert_json(&result.to_json()["request"], Json::Null);
    }

    #[test]
    fn a_restated_fund_is_priced_from_the_public_funds_closes() {
        let flat = json!([
            { "date": "2026-03-02", "close": 100, "adjustedClose": 100 },
            { "date": "2026-04-01", "close": 100, "adjustedClose": 100 },
        ]);
        let result = Case { closes: map(&[(FUND, json!({ "bars": flat }))]), ..Case::restated() }.preview();
        assert_json(&result.funds[0]["restatement"]["ok"], json!(true));
        let buy = &request(&result)["transactions"][0];
        assert_json(&json!([buy["transaction"]["price"], buy["transaction"]["quantity"]]), json!([100, 1]));
        assert_json(&buy["restated_from"], json!({ "investment": FUND, "units": 2, "unit_price": 50 }));
    }

    #[test]
    fn closes_still_loading_block_a_restated_fund_and_say_it_can_be_retried() {
        let loading = json!({ "message": "Prices for XIDX are still loading. Retry in a minute.", "retryable": true });
        let result = Case { closes: map(&[(FUND, loading)]), ..Case::restated() }.preview();
        assert_json(
            &result.funds[0]["restatement"],
            json!({ "ok": false, "spread": null, "message": "Prices for XIDX are still loading. Retry in a minute.", "retryable": true }),
        );
        assert!(result.request.is_none());
    }

    // Inferred dividends on a restated fund: a $0.50 payout going ex on 2026-03-16,
    // between the statement's two rows.
    fn bars() -> Vec<Json> {
        vec![
            json!({ "date": "2026-03-02", "close": 50, "adjustedClose": 49.5 }),
            json!({ "date": "2026-03-13", "close": 50, "adjustedClose": 49.5 }),
            json!({ "date": "2026-03-16", "close": 49, "adjustedClose": 49 }),
            json!({ "date": "2026-04-01", "close": 50, "adjustedClose": 50 }),
        ]
    }

    fn ex_id() -> String {
        get_reinvestment_id("acct-1", "sec-index", "2026-03-16")
    }

    #[test]
    fn inferred_dividends_are_sent_with_the_rows_listed_and_held() {
        let result = Case::restated().preview();
        assert_json(
            &Json::Array(result.reinvestments.clone()),
            json!([{ "investment": FUND, "ex_date": "2026-03-16", "amount": 1, "quantity": 1.0 / 49.0, "topUp": false }]),
        );
        let ids = transaction_ids(&result);
        assert!(ids.contains(&ex_id().as_str()) && ids.contains(&format!("{}-cash", ex_id()).as_str()));
        assert_close(&request(&result)["holdings"][0]["quantity"], 4.0 + 1.0 / 49.0, 10);
    }

    #[test]
    fn inferred_dividends_arent_inferred_for_a_fund_that_isnt_restated() {
        let result = Case { closes: Case::restated().closes, ..Default::default() }.preview();
        assert!(result.reinvestments.is_empty());
        assert!(!transaction_ids(&result).contains(&ex_id().as_str()));
    }

    #[test]
    fn inferred_dividends_arent_inferred_when_the_statement_reports_the_funds_dividends_itself() {
        let csv = format!("{CSV}\n03/16/2026,EXAMPLE INDEX FUND,Dividend,\"2.00\",\"0.0404\"");
        assert!(Case { csv, ..Case::restated() }.preview().reinvestments.is_empty());
    }

    #[test]
    fn inferred_dividends_arent_inferred_when_an_earlier_import_wrote_reported_dividends() {
        // But an inferred one, even renamed, doesn't stop them.
        let mut reported = buy_of("2026-01-15", 0.1);
        reported["investment_transaction_id"] = json!(format!("plan-{}", "a".repeat(32)));
        reported["subtype"] = json!("dividend reinvestment");
        assert!(Case { held: held(vec![reported.clone()], Vec::new()), ..Case::restated() }.preview().reinvestments.is_empty());
        let mut renamed = reported;
        renamed["investment_transaction_id"] = json!(format!("plan-dividend-{}", "b".repeat(32)));
        renamed["name"] = json!("My dividend");
        assert_eq!(Case { held: held(vec![renamed], Vec::new()), ..Case::restated() }.preview().reinvestments.len(), 1);
    }

    #[test]
    fn inferred_dividends_count_an_entered_position_unless_the_transactions_replace_it() {
        let ten = held(Vec::new(), vec![entered("2026-01-02", 10.0)]);
        assert_json(&Case { held: ten.clone(), ..Case::restated() }.preview().reinvestments[0]["amount"], json!(6));
        let replacing = Case { held: ten, replace: ids(&[FUND]), ..Case::restated() }.preview();
        assert_json(&replacing.reinvestments[0]["amount"], json!(1));
    }

    fn two_funds() -> Case {
        let csv = [
            CSV,
            "03/02/2026,EXAMPLE INDEX FUND B,Contributions,\"100.00\",\"2.000\"",
            "04/01/2026,EXAMPLE INDEX FUND B,Contributions,\"100.00\",\"2.000\"",
        ]
        .join("\n");
        Case {
            csv,
            mappings: map(&[(FUND, mapping(true)), ("EXAMPLE INDEX FUND B", mapping(true))]),
            closes: map(&[(FUND, json!({ "bars": bars() })), ("EXAMPLE INDEX FUND B", json!({ "bars": bars() }))]),
            ..Default::default()
        }
    }

    #[test]
    fn inferred_dividends_are_planned_once_for_two_funds_restated_into_one_security() {
        let result = two_funds().preview();
        assert_json(
            &Json::Array(result.reinvestments.clone()),
            json!([{
                "investment": "EXAMPLE INDEX FUND / EXAMPLE INDEX FUND B",
                "ex_date": "2026-03-16",
                "amount": 2,
                "quantity": 2.0 / 49.0,
                "topUp": false,
            }]),
        );
        let ids = transaction_ids(&result);
        assert_eq!(ids.iter().collect::<IndexSet<_>>().len(), ids.len());
        assert_eq!(request(&result)["holdings"].as_array().unwrap().len(), 1);
        assert_close(&request(&result)["holdings"][0]["quantity"], 8.0 + 2.0 / 49.0, 10);
    }

    #[test]
    fn inferred_dividends_cover_the_accounts_restated_fund_that_the_statement_has_no_rows_for() {
        let result = Case {
            mappings: map(&[(FUND, mapping(false)), ("EXAMPLE TRUST", trust())]),
            closes: map(&[("EXAMPLE TRUST", json!({ "bars": bars() }))]),
            held: held(vec![buy_of("2026-01-15", 3.0)], Vec::new()),
            ..Default::default()
        }
        .preview();
        assert_json(
            &Json::Array(result.reinvestments.clone()),
            json!([{ "investment": "EXAMPLE TRUST", "ex_date": "2026-03-16", "amount": 1.5, "quantity": 1.5 / 49.0, "topUp": false }]),
        );
        let holdings = request(&result)["holdings"].as_array().unwrap();
        let trust_holding = holdings.iter().find(|holding| holding["security_id"] == "sec-trust").unwrap();
        assert_close(&trust_holding["quantity"], 3.0 + 1.5 / 49.0, 10);
        assert_json(&request(&result)["mappings"], json!([{ "investment": FUND, "security_id": "sec-index", "restated": false }]));
    }

    #[test]
    fn replace_on_either_fund_of_one_security_applies_to_the_holding_as_a_whole() {
        for fund in [FUND, "EXAMPLE INDEX FUND B"] {
            let case = Case { replace: ids(&[fund]), held: held(Vec::new(), vec![entered("2026-01-02", 10.0)]), ..two_funds() };
            let result = case.preview();
            assert_json(&result.reinvestments[0]["amount"], json!(2));
            assert_json(&request(&result)["replace"], json!(["sec-index"]));
            assert_close(&request(&result)["holdings"][0]["quantity"], 8.0 + 2.0 / 49.0, 10);
            let replaced: Json = result.funds.iter().map(|fund| fund["replacePositions"].clone()).collect();
            assert_json(&replaced, json!([true, true]));
        }
    }

    fn with_a_loading_trust(held: Held) -> Case {
        Case {
            mappings: map(&[(FUND, mapping(false)), ("EXAMPLE TRUST", trust())]),
            closes: map(&[("EXAMPLE TRUST", json!({ "message": "Prices for XTR are loading…" }))]),
            held,
            ..Default::default()
        }
    }

    #[test]
    fn a_restated_holding_whose_prices_havent_loaded_blocks_the_import_and_says_it_can_be_retried() {
        let result = with_a_loading_trust(held(vec![buy_of("2026-01-15", 3.0)], Vec::new())).preview();
        assert_eq!(result.blockers, ["EXAMPLE TRUST: Prices for XTR are loading…"]);
        assert!(result.retry_closes);
        assert!(result.request.is_none());
        let nothing_held = with_a_loading_trust(Held::default()).preview();
        assert!(nothing_held.blockers.is_empty());
        assert!(!nothing_held.retry_closes);
    }

    #[test]
    fn inferred_dividends_cover_the_payouts_since_the_latest_earlier_plan_statement_row() {
        // So statements imported in order miss none. Payouts on 01-14, before the last
        // earlier row, and on 02-03, between it and the statement's first row.
        let mut earlier = vec![
            json!({ "date": "2026-01-13", "close": 50, "adjustedClose": 48.5 }),
            json!({ "date": "2026-01-14", "close": 50, "adjustedClose": 49 }),
            json!({ "date": "2026-02-02", "close": 50, "adjustedClose": 49 }),
            json!({ "date": "2026-02-03", "close": 50, "adjustedClose": 49.5 }),
        ];
        earlier.extend(bars());
        let result = Case {
            closes: map(&[(FUND, json!({ "bars": earlier }))]),
            // A manual row after the 02-03 payout doesn't mark where an earlier import's period ended.
            account_rows: vec![
                plan_row("2026-01-10"),
                plan_row("2026-01-15"),
                json!({ "investment_transaction_id": "manual-1", "date": "2026-02-10" }),
            ],
            held: held(vec![buy_of("2026-01-10", 2.0), buy_of("2026-01-15", 2.0)], Vec::new()),
            ..Case::restated()
        }
        .preview();
        let ex_dates: Json = result.reinvestments.iter().map(|r| r["ex_date"].clone()).collect();
        assert_json(&ex_dates, json!(["2026-02-03", "2026-03-16"]));
    }

    #[test]
    fn inference_period_starts_after_the_latest_plan_statement_row_before_the_statement() {
        let rows = parse_plan_statement(CSV).rows;
        assert_json(&inference_period(&rows, &[]).unwrap(), json!({ "after": null, "through": "2026-04-01" }));
        let account_rows = [
            plan_row("2026-01-10"),
            plan_row("2026-02-20T00:00:00.000Z"),
            json!({ "investment_transaction_id": "manual-1", "date": "2026-02-25" }),
            plan_row("2026-03-02"),
            plan_row("2026-05-01"),
        ];
        assert_json(&inference_period(&rows, &account_rows).unwrap(), json!({ "after": "2026-02-20", "through": "2026-04-01" }));
        assert!(inference_period(&[], &[]).is_err());
        assert!(inference_period(&rows, &[json!({ "date": "2026-01-10" })]).is_err());
        assert!(inference_period(&rows, &[json!({ "investment_transaction_id": "plan-1", "date": null })]).is_err());
        assert!(inference_period(&rows, &[json!({ "investment_transaction_id": "manual-1", "date": null })]).is_ok());
    }

    #[test]
    fn restatement_closes_range_spans_that_period_and_the_statements_rows() {
        let rows = parse_plan_statement(CSV).rows;
        assert_json(&restatement_closes_range(&rows, &[]).unwrap(), json!({ "from": "2026-02-20", "to": "2026-04-01" }));
        assert_json(
            &restatement_closes_range(&rows, &[plan_row("2026-01-09")]).unwrap(),
            json!({ "from": "2025-12-30", "to": "2026-04-01" }),
        );
        // A later statement's rows, whose reinvestments this one's rows may need to top up.
        assert_json(
            &restatement_closes_range(&rows, &[plan_row("2026-06-15")]).unwrap(),
            json!({ "from": "2026-02-20", "to": "2026-06-15" }),
        );
    }

    #[test]
    fn the_range_of_closes_starts_ten_days_before_the_earliest_date() {
        assert_json(&closes_range(&["2026-03-10", "2026-01-05", "2026-02-01"]).unwrap(), json!({ "from": "2025-12-26", "to": "2026-03-10" }));
        assert_json(&closes_range(&["2024-03-05".to_string()]).unwrap(), json!({ "from": "2024-02-24", "to": "2024-03-05" }));
        assert!(closes_range::<&str>(&[]).is_err());
        assert!(closes_range(&["soon"]).is_err());
        assert_eq!(CLOSES_LEAD_DAYS, 10);
    }

    #[test]
    fn a_reinvestment_found_deleted_isnt_planned_again() {
        let deleted = Case { deleted_ids: ids(&[&ex_id()]), ..Case::restated() }.preview();
        assert!(deleted.reinvestments.is_empty());
        assert_json(&request(&deleted)["holdings"][0]["quantity"], json!(4));
    }

    #[test]
    fn a_statement_row_found_deleted_stays_out_and_its_shares_earn_nothing() {
        let first = row_ids().remove(0);
        let result = Case { deleted_ids: ids(&[&first]), ..Case::restated() }.preview();
        assert_eq!(statuses(&result), ["imported", "new"]);
        assert!(!transaction_ids(&result).contains(&first.as_str()));
        assert!(result.reinvestments.is_empty());
        assert_json(&request(&result)["holdings"][0]["quantity"], json!(2));
    }

    fn with_a_loading_trust_beside_the_restated_fund(csv: String, held: Held) -> Case {
        let mut closes = Case::restated().closes;
        closes.insert("EXAMPLE TRUST".to_string(), json!({ "message": "Prices for XTR are loading…" }));
        Case { csv, mappings: map(&[(FUND, mapping(true)), ("EXAMPLE TRUST", trust())]), closes, held, ..Default::default() }
    }

    #[test]
    fn one_holdings_missing_prices_stop_inference_for_every_holding() {
        let case = with_a_loading_trust_beside_the_restated_fund(CSV.to_string(), held(vec![buy_of("2026-01-15", 3.0)], Vec::new()));
        let result = case.preview();
        assert_eq!(result.blockers, ["EXAMPLE TRUST: Prices for XTR are loading…"]);
        assert!(result.reinvestments.is_empty());
    }

    #[test]
    fn an_ex_date_already_in_the_account_isnt_sent_again() {
        let mut existing: IndexSet<String> = row_ids().into_iter().collect();
        existing.insert(ex_id());
        assert!(Case { existing_ids: existing, ..Case::restated() }.preview().reinvestments.is_empty());
    }

    #[test]
    fn statements_imported_out_of_order_end_as_if_imported_in_order() {
        // Payouts of $0.50 go ex 12-22 and 02-10; units track 0.5 × the adjusted close.
        let flat = [
            ("2025-11-03", 0.9801),
            ("2025-12-17", 0.9801),
            ("2025-12-19", 0.9801),
            ("2025-12-22", 0.99),
            ("2026-01-09", 0.99),
            ("2026-02-09", 0.99),
            ("2026-02-10", 1.0),
            ("2026-02-24", 1.0),
        ];
        let trust_bars: Vec<Json> =
            flat.iter().map(|(date, factor)| json!({ "date": date, "close": 50, "adjustedClose": js::num(50.0 * factor) })).collect();
        let statement = |dates: &[&str]| -> String {
            let mut lines = vec!["Date,Investment,Transaction Type,Amount,Shares/Unit".to_string()];
            for date in dates {
                let adjusted = 50.0 * flat.iter().find(|(day, _)| day == date).unwrap().1;
                let (y, m, d) = (&date[..4], &date[5..7], &date[8..]);
                lines.push(format!("{m}/{d}/{y},EXAMPLE INDEX FUND,Contributions,\"500.00\",\"{}\"", js::to_fixed(1000.0 / adjusted, 4)));
            }
            lines.join("\n")
        };
        let a = statement(&["2025-11-03", "2025-12-17"]);
        let b = statement(&["2026-01-09", "2026-02-24"]);
        // The shares bought, the dividends paid and the top-ups planned over the statements in turn.
        let import_in_order = |csvs: &[&String]| -> (f64, f64, usize) {
            let mut account: Vec<Json> = Vec::new();
            let mut top_ups = 0;
            for csv in csvs {
                let id = |movement: &Json| movement["investment_transaction_id"].as_str().unwrap().to_string();
                let result = Case {
                    csv: csv.to_string(),
                    closes: map(&[(FUND, json!({ "bars": trust_bars }))]),
                    existing_ids: account.iter().map(id).collect(),
                    account_rows: account.iter().map(|m| json!({ "investment_transaction_id": id(m), "date": m["date"] })).collect(),
                    through_month: "2026-03",
                    held: held(account.clone(), Vec::new()),
                    ..Case::restated()
                }
                .preview();
                account.extend(request(&result)["transactions"].as_array().unwrap().iter().map(|t| t["transaction"].clone()));
                top_ups += result.reinvestments.iter().filter(|r| r["topUp"] == true).count();
            }
            let figure = |movement: &Json, key: &str| movement[key].as_f64().unwrap();
            let shares: f64 = account.iter().filter(|m| m["type"] == "buy").map(|m| figure(m, "quantity")).sum();
            let dividends = account.iter().filter(|m| m["subtype"] == "dividend").fold(0.0, |sum, m| sum - figure(m, "amount"));
            (shares, js::math_round(dividends * 100.0) / 100.0, top_ups)
        };
        let in_order = import_in_order(&[&a, &b]);
        assert_eq!((in_order.1, in_order.2), (25.1, 0));
        let out_of_order = import_in_order(&[&b, &a, &b]);
        assert_eq!((out_of_order.1, out_of_order.2), (in_order.1, 2));
        assert!((out_of_order.0 - in_order.0).abs() < 0.5e-6);
    }

    #[test]
    fn a_blocker_leaves_nothing_inferred_even_on_shares_already_held() {
        let csv = format!("{CSV}\n04/02/2026,EXAMPLE INDEX FUND,Transfers,\"5.00\",\"0.100\"");
        let result = with_a_loading_trust_beside_the_restated_fund(csv, held(vec![buy_of("2026-01-15", 2.0)], Vec::new())).preview();
        // The statement's own blocker stands alone; held holdings' prices are only checked once nothing else blocks.
        assert_eq!(result.blockers, ["1 row needs a decision"]);
        assert!(result.reinvestments.is_empty());
    }

    #[test]
    fn a_file_with_no_statement_rows_is_an_error_not_a_preview() {
        let outcome = Case { csv: "no header here".to_string(), ..Default::default() }.outcome();
        assert_json(&outcome.to_json(), json!({ "error": "No \"Date,Investment,Transaction Type,Amount,Shares/Unit\" header found." }));
        let empty = Case { csv: "Date,Investment,Transaction Type,Amount,Shares/Unit\n".to_string(), ..Default::default() }.outcome();
        assert_eq!(empty, PreviewOutcome::Error { error: "The file has no statement rows.".to_string() });
    }

    #[test]
    fn the_holding_is_asked_about_by_security_and_closes_must_be_objects() {
        let asked: std::cell::RefCell<Vec<String>> = Default::default();
        let case = Case::default();
        let outcome = preview_plan_statement(&PreviewInput {
            account_id: "acct-1",
            iso_currency_code: "USD",
            csv: &case.csv,
            mappings: &case.mappings,
            decisions: &case.decisions,
            closes: &map(&[(FUND, Json::Null)]),
            existing_ids: &case.existing_ids,
            deleted_ids: &case.deleted_ids,
            replace: &case.replace,
            account_rows: &case.account_rows,
            holding: &|security_id| {
                asked.borrow_mut().push(security_id.to_string());
                Held::default()
            },
            through_month: case.through_month,
        });
        assert!(outcome.is_err());
        assert!(asked.borrow().is_empty());

        // A mapping with no security to its name holds nothing, and the callback isn't asked about it.
        let unnamed = Case { mappings: map(&[(FUND, json!({ "restated": false, "ticker_symbol": "XIDX" }))]), ..Default::default() };
        let result = unnamed.preview();
        assert_json(&request(&result)["mappings"], json!([{ "investment": FUND, "restated": false }]));
        assert_json(&request(&result)["holdings"], json!([{ "date": "2026-04-01", "quantity": 4, "cost_basis": 200, "price": 50 }]));
        assert!(result.transactions[0]["transaction"].get("security_id").is_none());
    }
}
