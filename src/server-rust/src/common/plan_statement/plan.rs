//! `src/common/plan-statement/plan.ts`.
//!
//! The JSON objects, with the TypeScript's keys:
//!
//! - `DailyClose`: `{ date, close, adjustedClose }`, `date` the trading day
//!   (`YYYY-MM-DD`) the bar belongs to.
//! - `FundMapping`: `{ security_id, restated, ticker_symbol }`.
//! - `RestatementCheck`: `{ ok, spread, message?, retryable? }`. `spread` is
//!   how far apart the trust's unit price over the public fund's adjusted
//!   close must be across the rows, after allowing each row the rounding in
//!   its own figures; `retryable` says the closes couldn't be fetched yet.
//! - `PlannedTransaction`: `{ transaction, restated_from?, reinvested_distribution? }`
//!   with `restated_from` a `RestatedFrom`, `{ investment, units, unit_price }`.
//! - `PlannedRow`: the statement row with `id` ahead of it and `status`
//!   (`new`, `imported`, `skip`, `decide`), `kind?`, `reason?`,
//!   `needsDecision?`, `allowedDecisions?` after it.
//! - `FundSummary`: `{ investment, mapping, newRows, restatement?, positionGaps?, replacePositions? }`.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::anyhow;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;

use crate::common::constants::PLAN_STATEMENT_ID_PREFIX;
use crate::common::holding_positions::value::{
    gt, is_number, join_text, math_max, math_min, nullish, text, to_number, to_text, Key, Literal, Num,
};
use crate::common::holding_positions::Movement;
use crate::common::utils::hash128;
use crate::js::{self, Json};

/// `InvestmentTransactionType`'s members the import writes.
pub(crate) const BUY: &str = "buy";
pub(crate) const SELL: &str = "sell";
pub(crate) const CASH: &str = "cash";

/// What an import writes for a statement row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImportKind {
    Contribution,
    Dividend,
    Fee,
    WithdrawalOut,
    WithdrawalKept,
    RolloverIn,
}

impl ImportKind {
    /// The TypeScript's `"contribution" | "dividend" | …`.
    pub fn as_str(self) -> &'static str {
        match self {
            ImportKind::Contribution => "contribution",
            ImportKind::Dividend => "dividend",
            ImportKind::Fee => "fee",
            ImportKind::WithdrawalOut => "withdrawal_out",
            ImportKind::WithdrawalKept => "withdrawal_kept",
            ImportKind::RolloverIn => "rollover_in",
        }
    }

    pub fn parse(text: &str) -> Option<ImportKind> {
        KIND_SPECS.iter().map(|(kind, _)| *kind).find(|kind| kind.as_str() == text)
    }

    /// `KIND_SPECS[kind]`.
    pub fn spec(self) -> &'static KindSpec {
        &KIND_SPECS[self as usize].1
    }

    /// `KIND_LABELS[kind]`.
    pub fn label(self) -> &'static str {
        KIND_LABELS[self as usize].1
    }
}

/// What the user can decide for a row the rules leave to them: one of the kinds, or `"skip"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Decision {
    Kind(ImportKind),
    Skip,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Kind(kind) => kind.as_str(),
            Decision::Skip => "skip",
        }
    }

    pub fn parse(text: &str) -> Option<Decision> {
        if text == "skip" {
            Some(Decision::Skip)
        } else {
            ImportKind::parse(text).map(Decision::Kind)
        }
    }
}

pub const DECISIONS: [Decision; 7] = [
    Decision::Kind(ImportKind::Contribution),
    Decision::Kind(ImportKind::Dividend),
    Decision::Kind(ImportKind::Fee),
    Decision::Kind(ImportKind::WithdrawalOut),
    Decision::Kind(ImportKind::WithdrawalKept),
    Decision::Kind(ImportKind::RolloverIn),
    Decision::Skip,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KindSpec {
    pub shares_arrive: bool,
    /// An `InvestmentTransactionSubtype`.
    pub subtype: &'static str,
    pub name: &'static str,
    /// The cash row beside the share movement, for money crossing the account boundary.
    pub cash: Option<CashSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CashSpec {
    /// An `InvestmentTransactionSubtype`.
    pub subtype: &'static str,
    pub name: &'static str,
    pub money_arrives: bool,
}

/// `KIND_SPECS`, in the order of its keys: `Object.values(KIND_SPECS)` is
/// `KIND_SPECS.iter().map(|(_, spec)| spec)`.
pub const KIND_SPECS: [(ImportKind, KindSpec); 6] = [
    (
        ImportKind::Contribution,
        KindSpec {
            shares_arrive: true,
            subtype: "contribution",
            name: "Buy (contribution)",
            cash: Some(CashSpec { subtype: "contribution", name: "Contribution", money_arrives: true }),
        },
    ),
    (
        ImportKind::Dividend,
        KindSpec {
            shares_arrive: true,
            subtype: "dividend reinvestment",
            name: "Buy (dividend reinvestment)",
            cash: Some(CashSpec { subtype: "dividend", name: "Dividend", money_arrives: true }),
        },
    ),
    (
        ImportKind::Fee,
        KindSpec {
            shares_arrive: false,
            subtype: "management fee",
            name: "Sell (fee)",
            cash: Some(CashSpec { subtype: "management fee", name: "Fee", money_arrives: false }),
        },
    ),
    (
        ImportKind::WithdrawalOut,
        KindSpec {
            shares_arrive: false,
            subtype: "sell",
            name: "Sell (withdrawal)",
            cash: Some(CashSpec { subtype: "withdrawal", name: "Withdrawal", money_arrives: false }),
        },
    ),
    (ImportKind::WithdrawalKept, KindSpec { shares_arrive: false, subtype: "sell", name: "Sell (withdrawal)", cash: None }),
    (
        ImportKind::RolloverIn,
        KindSpec {
            shares_arrive: true,
            subtype: "buy",
            name: "Buy (rollover in)",
            cash: Some(CashSpec { subtype: "transfer", name: "Rollover in", money_arrives: true }),
        },
    ),
];

/// `KIND_LABELS`, in the order of its keys.
pub const KIND_LABELS: [(ImportKind, &str); 6] = [
    (ImportKind::Contribution, "contribution"),
    (ImportKind::Dividend, "dividend reinvestment"),
    (ImportKind::Fee, "fee"),
    (ImportKind::WithdrawalOut, "withdrawal"),
    (ImportKind::WithdrawalKept, "withdrawal"),
    (ImportKind::RolloverIn, "rollover"),
];

/// The TypeScript's `Classification` union:
///
/// - `{ status: "write", kind }` is `Write { kind }`
/// - `{ status: "skip", reason }` is `Skip { reason }`
/// - `{ status: "decide", reason }` is `Decide { reason }`
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Classification {
    Write { kind: ImportKind },
    Skip { reason: String },
    Decide { reason: String },
}

impl Classification {
    pub fn status(&self) -> &'static str {
        match self {
            Classification::Write { .. } => "write",
            Classification::Skip { .. } => "skip",
            Classification::Decide { .. } => "decide",
        }
    }

    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        let literal = Literal::new().set("status", self.status());
        match self {
            Classification::Write { kind } => literal.set("kind", kind.as_str()),
            Classification::Skip { reason } | Classification::Decide { reason } => literal.set("reason", reason.as_str()),
        }
        .into()
    }
}

fn skip(reason: &str) -> Classification {
    Classification::Skip { reason: reason.to_string() }
}

fn decide(reason: &str) -> Classification {
    Classification::Decide { reason: reason.to_string() }
}

/// `\s+` as JavaScript reads it.
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+").unwrap()
});
static CONTRIBUTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^contributions?$").unwrap());
static DIVIDEND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^dividends?$").unwrap());
// `\b` is between an ASCII word character and anything else, as it is in a JavaScript regex without the `u` flag.
static ADVISOR_FEE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)(advisor|advisory|consultant|consulting)(?-u:\b).*(?-u:\b)fees?(?-u:\b)").unwrap());
static WITHDRAWAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^withdrawals?$").unwrap());
static TRANSFER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^transfers?$").unwrap());

/// What a statement row writes, from its label alone. Anything the rules don't
/// name is left to the user; a guessed label would put wrong rows in the account.
///
/// Reads the row's `label`, `amount` and `shares`. A `label` that is not a
/// string is an error.
pub fn classify_row(row: &Json) -> anyhow::Result<Classification> {
    let lowered = text(row.get("label"), "a statement row's label")?.to_lowercase();
    let collapsed = WHITESPACE.replace_all(&lowered, " ");
    let label = collapsed.trim_matches(' ');
    let (amount, shares) = (row.get("amount"), row.get("shares"));
    if is_number(amount, 0.0) && is_number(shares, 0.0) {
        return Ok(skip("No amount or shares"));
    }

    let kind = if CONTRIBUTION.is_match(label) {
        ImportKind::Contribution
    } else if DIVIDEND.is_match(label) {
        ImportKind::Dividend
    } else if ADVISOR_FEE.is_match(label) {
        ImportKind::Fee
    } else if label == "conversion balance" {
        ImportKind::RolloverIn
    } else if WITHDRAWAL.is_match(label) {
        return Ok(decide("Does this money leave the account or stay as cash?"));
    } else if TRANSFER.is_match(label) {
        return Ok(decide("A transfer that moves money or shares"));
    } else if label == "change in market value" {
        if is_number(shares, 0.0) {
            return Ok(skip("Market value change, no shares moved"));
        }
        return Ok(decide("A market value change that moves shares"));
    } else {
        return Ok(decide("This transaction type isn't recognized"));
    };

    if is_number(shares, 0.0) || is_number(amount, 0.0) {
        return Ok(decide("The row is missing its amount or its shares"));
    }
    if !fits_kind(kind, row) {
        return Ok(decide(&format!("The figures point the other way from a {}", kind.label())));
    }
    Ok(Classification::Write { kind })
}

/// Whether a row's figures move the way a kind does: both positive when shares
/// arrive, both negative when they leave. A row that disagrees (a reversed
/// contribution, a fee refund, or an amount and shares of opposite signs) is not
/// written as that kind with its signs dropped.
pub fn fits_kind(kind: ImportKind, row: &Json) -> bool {
    let (amount, shares) = (to_number(row.get("amount")), to_number(row.get("shares")));
    if kind.spec().shares_arrive {
        amount > 0.0 && shares > 0.0
    } else {
        amount < 0.0 && shares < 0.0
    }
}

/// The choices a decision row offers: the kinds its figures fit, and skipping it.
pub fn allowed_decisions(row: &Json) -> Vec<Decision> {
    let kinds = KIND_SPECS.iter().map(|(kind, _)| *kind).filter(|kind| fits_kind(*kind, row));
    kinds.map(Decision::Kind).chain([Decision::Skip]).collect()
}

/// `value.toFixed(digits)`, which only a number has.
fn fixed(value: Option<&Json>, digits: usize, what: &str) -> anyhow::Result<String> {
    match value {
        Some(Json::Number(number)) => Ok(js::to_fixed(number.as_f64().unwrap_or(f64::NAN), digits)),
        other => Err(anyhow!("{what} is not a number: {}", to_text(other))),
    }
}

/// Deterministic ids, so importing an overlapping statement recognises the rows
/// it already wrote. Identical rows on the same day (two equal contributions)
/// are told apart by their position among the identical ones.
///
/// An `amount` or `shares` that is not a number is an error.
pub fn get_row_ids(account_id: &str, rows: &[Json]) -> anyhow::Result<Vec<String>> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let fingerprint = [
            account_id.to_string(),
            join_text(row.get("date")),
            join_text(row.get("investment")),
            join_text(row.get("label")),
            fixed(row.get("amount"), 2, "a statement row's amount")?,
            fixed(row.get("shares"), 6, "a statement row's shares")?,
        ]
        .join("\0");
        let occurrence = seen.entry(fingerprint.clone()).or_insert(0);
        ids.push(format!("{PLAN_STATEMENT_ID_PREFIX}{}", hash128(&format!("{fingerprint}\0{occurrence}"))));
        *occurrence += 1;
    }
    Ok(ids)
}

pub fn get_cash_leg_id(id: &str) -> String {
    format!("{id}-cash")
}

/// A planned row's id: a statement row's or an inferred dividend's share movement, or its cash leg.
pub static PLAN_STATEMENT_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^plan-(dividend-)?[0-9a-f]{32}(-cash)?$").unwrap());

/// A statement date can fall on a weekend or market holiday.
const MAX_CLOSE_LOOKBACK_DAYS: f64 = 7.0;
pub const MAX_RESTATEMENT_SPREAD: f64 = 0.015;

/// [`close_on_or_before`] for a date as a row holds it.
pub(crate) fn close_before<'a>(bars: &'a [Json], date: Option<&Json>) -> Option<&'a Json> {
    let mut found = None;
    for bar in bars {
        if gt(bar.get("date"), date) {
            break;
        }
        found = Some(bar);
    }
    let found = found.filter(|bar| js::truthy(bar))?;
    let midnight = |day: Option<&Json>| js::date_parse(&format!("{}T00:00:00Z", to_text(day)));
    let gap_days = (midnight(date) - midnight(found.get("date"))) / 86_400_000.0;
    (gap_days <= MAX_CLOSE_LOOKBACK_DAYS).then_some(found)
}

/// The latest bar on or before `date`, unless it is more than a week old.
/// `bars` are `DailyClose`s, oldest first.
pub fn close_on_or_before<'a>(bars: &'a [Json], date: &str) -> Option<&'a Json> {
    close_before(bars, Some(&Json::String(date.to_string())))
}

const DEFAULT_SHARE_ROUNDING: f64 = 0.0005;
const AMOUNT_ROUNDING: f64 = 0.005;
/// The most a single row's rounding may move its unit price and still be
/// measured. Past it the row can't confirm anything against a 1.5% band, and
/// an uncapped allowance would let coarse figures (whole shares, say) pass
/// drift the check can't see.
const MAX_ROW_ALLOWANCE: f64 = 0.0025;
/// One measured row gives no spread at all, so it confirms nothing.
const MIN_MEASURED_ROWS: usize = 2;

fn restatement(rows: &[&Json], bars: &[Json], ticker: &str) -> Json {
    let refused = |message: String| -> Json {
        Literal::new().set("ok", false).set("spread", Json::Null).set("message", message).into()
    };
    let mut highest_low = 0.0;
    let mut lowest_high = f64::INFINITY;
    let mut measured = 0;
    for row in rows {
        let Some(bar) = close_before(bars, row.get("date")) else {
            return refused(format!("No {ticker} close on or just before {}", to_text(row.get("date"))));
        };
        let units = to_number(row.get("shares")).abs();
        let dollars = to_number(row.get("amount")).abs();
        let share_rounding = row.get("shareRounding");
        let rounding = if nullish(share_rounding) { DEFAULT_SHARE_ROUNDING } else { to_number(share_rounding) };
        let unmeasurable = |figure: f64| figure == 0.0 || figure.is_nan();
        if unmeasurable(units) || unmeasurable(dollars) || rounding / units + AMOUNT_ROUNDING / dollars > MAX_ROW_ALLOWANCE {
            continue;
        }
        let adjusted_close = to_number(bar.get("adjustedClose"));
        highest_low = math_max(highest_low, (dollars - AMOUNT_ROUNDING) / (units + rounding) / adjusted_close);
        lowest_high = math_min(lowest_high, (dollars + AMOUNT_ROUNDING) / (units - rounding) / adjusted_close);
        measured += 1;
    }
    if measured < MIN_MEASURED_ROWS {
        return refused(format!(
            "Too few rows give shares precisely enough to check the restatement ({measured} of {})",
            rows.len()
        ));
    }
    let spread = math_max(0.0, highest_low / lowest_high - 1.0);
    if spread > MAX_RESTATEMENT_SPREAD {
        return Literal::new()
            .set("ok", false)
            .num("spread", spread)
            .set(
                "message",
                format!(
                    "Unit price drifts {}% against {ticker}, more than {}%",
                    js::to_fixed(spread * 100.0, 2),
                    js::to_fixed(MAX_RESTATEMENT_SPREAD * 100.0, 1)
                ),
            )
            .into();
    }
    Literal::new().set("ok", true).num("spread", spread).into()
}

/// Restating is only sound while the trust's unit price stays a fixed multiple
/// of the public fund's dividend-adjusted close, so the rows about to be written
/// are measured against it, with the rows already imported from it. A
/// statement gives shares to a few decimals, so each row counts as the range
/// of ratios its rounded figures allow, and the check asks whether one
/// multiple fits all of them within the band. Rows whose rounding alone moves
/// the unit price more than `MAX_ROW_ALLOWANCE` aren't measured, and fewer
/// than two measured rows is a refusal, not a pass.
///
/// Reads each row's `date`, `amount`, `shares` and `shareRounding`; returns a
/// `RestatementCheck`.
pub fn check_restatement(rows: &[Json], bars: &[Json], ticker: &str) -> Json {
    restatement(&rows.iter().collect::<Vec<_>>(), bars, ticker)
}

/// What [`build_import_plan`] returns: `{ rows, funds, transactions, blockers }`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ImportPlan {
    /// `PlannedRow`s, one per statement row.
    pub rows: Vec<Json>,
    /// `FundSummary`s, one per fund the statement names.
    pub funds: Vec<Json>,
    /// `PlannedTransaction`s.
    pub transactions: Vec<Json>,
    /// Why the plan can't be imported yet; empty when it can.
    pub blockers: Vec<String>,
}

impl ImportPlan {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        Literal::new()
            .set("rows", self.rows.clone())
            .set("funds", self.funds.clone())
            .set("transactions", self.transactions.clone())
            .set("blockers", self.blockers.clone())
            .into()
    }
}

/// What [`build_import_plan`] takes: the TypeScript's `PlanInput`.
#[derive(Clone, Copy, Debug)]
pub struct PlanInput<'a> {
    pub account_id: &'a str,
    pub iso_currency_code: &'a str,
    /// `StatementRow`s.
    pub rows: &'a [Json],
    /// A `FundMapping` per fund, keyed by the statement's fund name.
    pub mappings: &'a IndexMap<String, Json>,
    /// The `Decision` made for a row, by row id.
    pub decisions: &'a Json,
    /// Daily closes per restated fund, keyed by the statement's fund name.
    pub closes: &'a IndexMap<String, Vec<Json>>,
    /// Why a restated fund's closes couldn't be fetched, `{ message, retryable? }`, keyed the same way.
    pub close_errors: Option<&'a IndexMap<String, Json>>,
    /// Ids already in the account, deleted ones included, so a removed row isn't brought back.
    pub existing_ids: &'a IndexSet<String>,
}

/// A planned transaction: the `PlannedTransaction` to hand out, and the
/// movement it is to the holding with its figures as computed.
#[derive(Clone, Debug)]
pub(crate) struct Planned {
    pub(crate) json: Json,
    pub(crate) movement: Movement,
}

/// One leg of a planned row or reinvestment, before it is written out.
pub(crate) struct Leg<'a> {
    pub(crate) investment_transaction_id: Option<Json>,
    pub(crate) account_id: &'a str,
    pub(crate) security_id: Option<Json>,
    pub(crate) date: Option<Json>,
    pub(crate) name: &'a str,
    pub(crate) amount: f64,
    pub(crate) quantity: f64,
    pub(crate) price: Num,
    pub(crate) iso_currency_code: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) subtype: &'a str,
    pub(crate) restated_from: Option<Json>,
    pub(crate) reinvested_distribution: Option<Json>,
}

impl Leg<'_> {
    pub(crate) fn planned(self) -> Planned {
        let transaction = Literal::new()
            .opt("investment_transaction_id", self.investment_transaction_id.clone())
            .set("account_id", self.account_id)
            .opt("security_id", self.security_id.clone())
            .opt("date", self.date.clone())
            .set("name", self.name)
            .num("amount", self.amount)
            .num("quantity", self.quantity)
            .opt("price", self.price.json())
            .set("iso_currency_code", self.iso_currency_code)
            .set("type", self.kind)
            .set("subtype", self.subtype)
            .set("source", "manual");
        let json = Literal::new()
            .set("transaction", transaction)
            .opt("restated_from", self.restated_from)
            .opt("reinvested_distribution", self.reinvested_distribution)
            .into();
        let movement = Movement {
            investment_transaction_id: self.investment_transaction_id,
            date: self.date,
            kind: Some(Json::String(self.kind.to_string())),
            quantity: Num::Value(self.quantity),
            amount: Num::Value(self.amount),
            price: self.price,
            subtype: Some(Json::String(self.subtype.to_string())),
            security_id: self.security_id,
        };
        Planned { json, movement }
    }
}

/// An [`ImportPlan`] whose transactions still carry their figures as computed.
pub(crate) struct Plan {
    pub(crate) rows: Vec<Json>,
    pub(crate) funds: Vec<Json>,
    pub(crate) transactions: Vec<Planned>,
    pub(crate) blockers: Vec<String>,
}

/// [`PlanInput`] with the closes borrowed, as the preview has them.
pub(crate) struct PlanSource<'a> {
    pub(crate) account_id: &'a str,
    pub(crate) iso_currency_code: &'a str,
    pub(crate) rows: &'a [Json],
    pub(crate) mappings: &'a IndexMap<String, Json>,
    pub(crate) decisions: &'a Json,
    pub(crate) closes: IndexMap<&'a str, &'a [Json]>,
    pub(crate) close_errors: Option<&'a IndexMap<String, Json>>,
    pub(crate) existing_ids: &'a IndexSet<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Status {
    New,
    Imported,
    Skip,
    Decide,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::New => "new",
            Status::Imported => "imported",
            Status::Skip => "skip",
            Status::Decide => "decide",
        }
    }
}

fn round2(n: f64) -> f64 {
    js::math_round(n * 100.0) / 100.0
}

/// A `Map<string, …>`'s entry for a fund name as a row holds it: none unless the name is a string.
fn by_fund<'a, V: Copy>(map: &IndexMap<&'a str, V>, investment: Option<&Json>) -> Option<V> {
    investment.and_then(Json::as_str).and_then(|name| map.get(name)).copied()
}

pub(crate) fn plan_import(input: &PlanSource) -> anyhow::Result<Plan> {
    let (account_id, iso_currency_code, rows) = (input.account_id, input.iso_currency_code, input.rows);
    let mappings: IndexMap<&str, &Json> = input.mappings.iter().map(|(name, mapping)| (name.as_str(), mapping)).collect();
    let ids = get_row_ids(account_id, rows)?;

    // Each planned row, with the status and kind it was given.
    let mut planned: Vec<Json> = Vec::with_capacity(rows.len());
    let mut states: Vec<(Status, Option<ImportKind>)> = Vec::with_capacity(rows.len());
    let mut writes: Vec<bool> = Vec::with_capacity(rows.len());
    for (row, id) in rows.iter().zip(&ids) {
        let base = Literal::new().set("id", id.as_str()).spread(row);
        let classification = classify_row(row)?;
        let needs_decision = matches!(classification, Classification::Decide { .. });
        writes.push(matches!(classification, Classification::Write { .. }));
        let (status, kind, row): (Status, Option<ImportKind>, Literal) = if input.existing_ids.contains(id) {
            (Status::Imported, None, base.set("status", Status::Imported.as_str()).set("needsDecision", needs_decision))
        } else {
            match classification {
                Classification::Write { kind } => {
                    (Status::New, Some(kind), base.set("status", Status::New.as_str()).set("kind", kind.as_str()))
                }
                Classification::Skip { reason } => (Status::Skip, None, base.set("status", Status::Skip.as_str()).set("reason", reason)),
                Classification::Decide { reason } => {
                    let allowed = allowed_decisions(row);
                    let choices: Vec<Json> = allowed.iter().map(|decision| Json::from(decision.as_str())).collect();
                    let decided = base.set("needsDecision", needs_decision).set("allowedDecisions", choices);
                    let decision = input.decisions.get(id.as_str()).and_then(Json::as_str).and_then(Decision::parse);
                    match decision.filter(|decision| allowed.contains(decision)) {
                        Some(Decision::Skip) => {
                            (Status::Skip, None, decided.set("status", Status::Skip.as_str()).set("reason", "Skipped by you"))
                        }
                        Some(Decision::Kind(kind)) => {
                            (Status::New, Some(kind), decided.set("status", Status::New.as_str()).set("kind", kind.as_str()))
                        }
                        None => (Status::Decide, None, decided.set("status", Status::Decide.as_str()).set("reason", reason)),
                    }
                }
            }
        };
        planned.push(row.into());
        states.push((status, kind));
    }

    let mut blockers: Vec<String> = Vec::new();
    let undecided = states.iter().filter(|(status, _)| *status == Status::Decide).count();
    if undecided > 0 {
        blockers.push(if undecided == 1 { "1 row needs a decision".to_string() } else { format!("{undecided} rows need a decision") });
    }

    let row_funds: Vec<Key> = rows.iter().map(|row| Key::of(row.get("investment"))).collect();
    let fund_names: IndexSet<&Key> = row_funds.iter().collect();
    let mut funds: Vec<Json> = Vec::with_capacity(fund_names.len());
    for fund in fund_names {
        let investment = fund.value();
        let mapping = by_fund(&mappings, investment.as_ref()).filter(|mapping| !mapping.is_null());
        let of_fund = |status: &dyn Fn(usize) -> bool| -> Vec<&Json> {
            rows.iter().enumerate().filter(|(i, _)| row_funds[*i] == *fund && status(*i)).map(|(_, row)| row).collect()
        };
        let to_write = of_fund(&|i| states[i].0 == Status::New);
        // The rows written now, and the ones this statement already wrote.
        let measured = of_fund(&|i| states[i].0 == Status::New || (states[i].0 == Status::Imported && writes[i]));
        let mut summary = Literal::new()
            .opt("investment", investment.clone())
            .set("mapping", mapping.cloned().unwrap_or(Json::Null))
            .set("newRows", to_write.len());
        let mut blocker: Option<String> = None;
        if !to_write.is_empty() && mapping.is_none_or(|mapping| !js::truthy(mapping)) {
            blocker = Some(format!("Map {} to a security", to_text(investment.as_ref())));
        }
        if let Some(mapping) = mapping.filter(|mapping| js::truthy_opt(mapping.get("restated")) && !to_write.is_empty()) {
            let ticker = mapping.get("ticker_symbol").filter(|ticker| !ticker.is_null());
            let ticker_text = ticker.map(|ticker| to_text(Some(ticker))).unwrap_or_default();
            let bars = by_fund(&input.closes, investment.as_ref());
            let close_error = investment.as_ref().and_then(Json::as_str).and_then(|name| input.close_errors?.get(name));
            let restatement: Json = if !js::truthy_opt(ticker) {
                Literal::new()
                    .set("ok", false)
                    .set("spread", Json::Null)
                    .set("message", "A restated fund needs a security with a ticker")
                    .into()
            } else if let Some(bars) = bars.filter(|bars| !bars.is_empty()) {
                restatement(&measured, bars, &ticker_text)
            } else {
                let message = close_error.and_then(|error| error.get("message")).filter(|message| !message.is_null());
                Literal::new()
                    .set("ok", false)
                    .set("spread", Json::Null)
                    .set(
                        "message",
                        message.cloned().unwrap_or_else(|| Json::String(format!("No {ticker_text} closes for the statement's dates"))),
                    )
                    .opt("retryable", close_error.and_then(|error| error.get("retryable")).cloned())
                    .into()
            };
            if blocker.is_none() && !js::truthy_opt(restatement.get("ok")) {
                blocker =
                    Some(format!("{} can't be restated: {}", to_text(investment.as_ref()), to_text(restatement.get("message"))));
            }
            summary = summary.set("restatement", restatement);
        }
        blockers.extend(blocker);
        funds.push(summary.into());
    }

    let mut transactions: Vec<Planned> = Vec::new();
    if blockers.is_empty() {
        for (row, (status, kind)) in planned.iter().zip(&states) {
            let Some(kind) = kind.filter(|_| *status == Status::New) else { continue };
            let (investment, date, id) = (row.get("investment"), row.get("date"), row.get("id"));
            // A row is only new once its fund is mapped and, if restated, has a close for each of its rows.
            let mapping = by_fund(&mappings, investment).ok_or_else(|| anyhow!("{} has no mapping", to_text(investment)))?;
            let spec = kind.spec();
            let dollars = to_number(row.get("amount")).abs();
            let units = to_number(row.get("shares")).abs();
            let restated = js::truthy_opt(mapping.get("restated"));

            let (price, restated_from) = if restated {
                let bar = by_fund(&input.closes, investment)
                    .and_then(|bars| close_before(bars, date))
                    .ok_or_else(|| anyhow!("{} has no close on {}", to_text(investment), to_text(date)))?;
                let restated_from: Json = Literal::new()
                    .opt("investment", investment.cloned())
                    .opt("units", row.get("shares").cloned())
                    .num("unit_price", dollars / units)
                    .into();
                (Num::of(bar.get("close")), Some(restated_from))
            } else {
                (Num::Value(dollars / units), None)
            };
            let direction = if spec.shares_arrive { 1.0 } else { -1.0 };
            let quantity = direction * if restated { dollars / price.value() } else { units };

            transactions.push(
                Leg {
                    investment_transaction_id: id.cloned(),
                    account_id,
                    security_id: mapping.get("security_id").cloned(),
                    date: date.cloned(),
                    name: spec.name,
                    amount: if spec.shares_arrive { round2(dollars) } else { -round2(dollars) },
                    quantity,
                    price,
                    iso_currency_code,
                    kind: if spec.shares_arrive { BUY } else { SELL },
                    subtype: spec.subtype,
                    restated_from,
                    reinvested_distribution: None,
                }
                .planned(),
            );

            if let Some(cash) = spec.cash {
                transactions.push(
                    Leg {
                        investment_transaction_id: Some(Json::String(get_cash_leg_id(&to_text(id)))),
                        account_id,
                        security_id: Some(Json::Null),
                        date: date.cloned(),
                        name: cash.name,
                        // Positive when money leaves the account.
                        amount: if cash.money_arrives { -round2(dollars) } else { round2(dollars) },
                        quantity: 0.0,
                        price: Num::Value(0.0),
                        iso_currency_code,
                        kind: CASH,
                        subtype: cash.subtype,
                        restated_from: None,
                        reinvested_distribution: None,
                    }
                    .planned(),
                );
            }
        }
    }

    Ok(Plan { rows: planned, funds, transactions, blockers })
}

/// The plan for a statement's rows: what each row is, what each fund needs,
/// the transactions to write, and what stands in the way. A row whose `label`
/// is not a string, or whose `amount` or `shares` is not a number, is an error.
pub fn build_import_plan(input: &PlanInput) -> anyhow::Result<ImportPlan> {
    let plan = plan_import(&PlanSource {
        account_id: input.account_id,
        iso_currency_code: input.iso_currency_code,
        rows: input.rows,
        mappings: input.mappings,
        decisions: input.decisions,
        closes: input.closes.iter().map(|(name, bars)| (name.as_str(), bars.as_slice())).collect(),
        close_errors: input.close_errors,
        existing_ids: input.existing_ids,
    })?;
    Ok(ImportPlan {
        rows: plan.rows,
        funds: plan.funds,
        transactions: plan.transactions.into_iter().map(|planned| planned.json).collect(),
        blockers: plan.blockers,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::common::holding_positions::value::testing::{assert_close, assert_json};

    /// A statement row: the TypeScript tests' default with `over` on top.
    fn row(over: Json) -> Json {
        Literal::new()
            .spread(&json!({
                "line": 1,
                "date": "2026-03-02",
                "investment": "EXAMPLE INDEX FUND",
                "label": "Contributions",
                "amount": 100,
                "shares": 2,
            }))
            .spread(&over)
            .into()
    }

    fn index_fund() -> Json {
        json!({ "security_id": "sec-index", "restated": false, "ticker_symbol": "XIDX" })
    }

    fn trust() -> Json {
        json!({ "security_id": "sec-public", "restated": true, "ticker_symbol": "XPUB" })
    }

    /// The TypeScript tests' default input, with the parts they vary.
    struct Input {
        rows: Vec<Json>,
        mappings: IndexMap<String, Json>,
        decisions: Json,
        closes: IndexMap<String, Vec<Json>>,
        close_errors: Option<IndexMap<String, Json>>,
        existing_ids: IndexSet<String>,
    }

    impl Default for Input {
        fn default() -> Self {
            Input {
                rows: Vec::new(),
                mappings: IndexMap::from([("EXAMPLE INDEX FUND".to_string(), index_fund())]),
                decisions: json!({}),
                closes: IndexMap::new(),
                close_errors: None,
                existing_ids: IndexSet::new(),
            }
        }
    }

    impl Input {
        fn plan(&self) -> ImportPlan {
            build_import_plan(&PlanInput {
                account_id: "acct-1",
                iso_currency_code: "USD",
                rows: &self.rows,
                mappings: &self.mappings,
                decisions: &self.decisions,
                closes: &self.closes,
                close_errors: self.close_errors.as_ref(),
                existing_ids: &self.existing_ids,
            })
            .unwrap()
        }

        fn trust(rows: Vec<Json>, bars: Vec<Json>) -> Input {
            Input {
                rows,
                mappings: IndexMap::from([("EXAMPLE TRUST".to_string(), trust())]),
                closes: IndexMap::from([("EXAMPLE TRUST".to_string(), bars)]),
                ..Default::default()
            }
        }
    }

    fn statuses(plan: &ImportPlan) -> Vec<&str> {
        plan.rows.iter().map(|row| row["status"].as_str().unwrap()).collect()
    }

    fn of_type<'a>(plan: &'a ImportPlan, kind: &str) -> Vec<&'a Json> {
        plan.transactions.iter().filter(|t| t["transaction"]["type"] == kind).collect()
    }

    #[test]
    fn rows_are_classified_from_their_label_and_figures() {
        let cases: [(&str, f64, f64, &str, Option<&str>); 17] = [
            ("Contributions", 100.0, 2.0, "write", Some("contribution")),
            ("Dividend", 3.0, 0.05, "write", Some("dividend")),
            ("Advisor Fee", -4.0, -0.08, "write", Some("fee")),
            ("Consultant Fees", -4.0, -0.08, "write", Some("fee")),
            ("Conversion Balance", 5000.0, 100.0, "write", Some("rollover_in")),
            ("Transfers", 0.0, 0.0, "skip", None),
            ("Change in Market Value", 25.0, 0.0, "skip", None),
            ("Change in Market Value", 25.0, 0.5, "decide", None),
            ("Transfers", 50.0, 1.0, "decide", None),
            ("Withdrawals", -500.0, -10.0, "decide", None),
            ("Realized Gain/Loss", 12.0, 0.0, "decide", None),
            ("Loan Repayment", 40.0, 0.8, "decide", None),
            ("Contributions", 100.0, 0.0, "decide", None),
            ("Contributions", -100.0, -2.0, "decide", None),
            ("Contributions", 100.0, -2.0, "decide", None),
            ("Advisor Fee", 4.0, 0.08, "decide", None),
            ("Dividend", -3.0, -0.05, "decide", None),
        ];
        for (label, amount, shares, status, kind) in cases {
            let row = json!({ "label": label, "amount": js::num(amount), "shares": js::num(shares) });
            let classification = classify_row(&row).unwrap();
            assert_eq!(classification.status(), status, "{label} {amount} / {shares} shares");
            if let Some(kind) = kind {
                assert_eq!(classification, Classification::Write { kind: ImportKind::parse(kind).unwrap() });
            }
        }
    }

    #[test]
    fn every_classification_names_its_reason_as_the_typescript_words_it() {
        let reason = |label: &str, amount: i64, shares: i64| {
            classify_row(&json!({ "label": label, "amount": amount, "shares": shares })).unwrap().to_json()
        };
        assert_json(&reason("anything", 0, 0), json!({ "status": "skip", "reason": "No amount or shares" }));
        assert_json(&reason("Contribution", 1, 1), json!({ "status": "write", "kind": "contribution" }));
        assert_json(
            &reason("Withdrawal", -1, -1),
            json!({ "status": "decide", "reason": "Does this money leave the account or stay as cash?" }),
        );
        assert_json(&reason("Transfer", 1, 1), json!({ "status": "decide", "reason": "A transfer that moves money or shares" }));
        assert_json(
            &reason("Change in Market Value", 1, 0),
            json!({ "status": "skip", "reason": "Market value change, no shares moved" }),
        );
        assert_json(
            &reason("Change in Market Value", 1, 1),
            json!({ "status": "decide", "reason": "A market value change that moves shares" }),
        );
        assert_json(&reason("Loan", 1, 1), json!({ "status": "decide", "reason": "This transaction type isn't recognized" }));
        assert_json(
            &reason("Dividends", 1, 0),
            json!({ "status": "decide", "reason": "The row is missing its amount or its shares" }),
        );
        assert_json(
            &reason("Dividends", -1, -1),
            json!({ "status": "decide", "reason": "The figures point the other way from a dividend reinvestment" }),
        );
        assert_json(
            &reason("Advisory fee", 1, 1),
            json!({ "status": "decide", "reason": "The figures point the other way from a fee" }),
        );
    }

    #[test]
    fn a_label_is_read_in_any_case_and_spacing_and_the_fee_rule_goes_by_whole_words() {
        let kind = |label: &str| match classify_row(&json!({ "label": label, "amount": -1, "shares": -1 })).unwrap() {
            Classification::Write { kind } => Some(kind),
            _ => None,
        };
        assert_eq!(kind("  ADVISOR \t\u{a0} fee  "), Some(ImportKind::Fee));
        assert_eq!(kind("Plan consulting services - fees"), Some(ImportKind::Fee));
        assert_eq!(kind("advisors fee"), None);
        assert_eq!(kind("advisor feed"), None);
        assert_eq!(kind("subadvisor fee"), None);
        // A non-ASCII letter is not a word character, so it ends the word before it.
        assert_eq!(kind("advisor fee\u{e9}"), Some(ImportKind::Fee));
        assert_eq!(kind("\u{e9}advisor fee"), Some(ImportKind::Fee));
        // U+0085 is not whitespace to JavaScript, so it stays in the label.
        assert_eq!(kind("advisor fee\u{85}"), Some(ImportKind::Fee));
        let contribution = |label: &str| classify_row(&json!({ "label": label, "amount": 1, "shares": 1 })).unwrap().status();
        assert_eq!(contribution(" Contributions\u{feff}"), "write");
        assert_eq!(contribution("Contributions\u{85}"), "decide");
        assert!(classify_row(&json!({ "amount": 1, "shares": 1 })).is_err());
        assert!(classify_row(&json!({ "label": null, "amount": 0, "shares": 0 })).is_err());
    }

    #[test]
    fn lowercasing_follows_javascript() {
        // `["İ", "ΑΣ", "ǅ", "ẞ", "ΑΣ Β", "Σ", "AΣ.", "A­Σ"].map((s) => s.toLowerCase())` under Bun.
        let lowered: Vec<String> =
            ["İ", "ΑΣ", "ǅ", "ẞ", "ΑΣ Β", "Σ", "AΣ.", "A\u{ad}Σ"].iter().map(|text| text.to_lowercase()).collect();
        assert_eq!(lowered, ["i\u{307}", "ας", "ǆ", "ß", "ας β", "σ", "aς.", "a\u{ad}ς"]);
    }

    #[test]
    fn the_decisions_a_row_allows_are_the_kinds_its_figures_fit() {
        let allowed = |amount: i64, shares: i64| -> Vec<&str> {
            allowed_decisions(&json!({ "amount": amount, "shares": shares })).into_iter().map(Decision::as_str).collect()
        };
        assert_eq!(allowed(1, 1), ["contribution", "dividend", "rollover_in", "skip"]);
        assert_eq!(allowed(-1, -1), ["fee", "withdrawal_out", "withdrawal_kept", "skip"]);
        assert_eq!(allowed(1, -1), ["skip"]);
        assert_eq!(allowed(0, 0), ["skip"]);
        assert_eq!(
            DECISIONS.map(Decision::as_str),
            ["contribution", "dividend", "fee", "withdrawal_out", "withdrawal_kept", "rollover_in", "skip"]
        );
        assert_eq!(DECISIONS.map(|decision| Decision::parse(decision.as_str())), DECISIONS.map(Some));
        for (kind, spec) in KIND_SPECS {
            assert_eq!(kind.spec(), &spec);
            assert_eq!(ImportKind::parse(kind.as_str()), Some(kind));
        }
        for (kind, label) in KIND_LABELS {
            assert_eq!(kind.label(), label);
        }
        assert_eq!(ImportKind::parse("skip"), None);
    }

    #[test]
    fn the_same_row_gets_the_same_id_in_every_statement_it_appears_in() {
        let first = get_row_ids("acct-1", &[row(json!({ "line": 9 })), row(json!({ "date": "2026-04-01" }))]).unwrap();
        let second = get_row_ids("acct-1", &[row(json!({ "date": "2026-01-01" })), row(json!({ "line": 30 }))]).unwrap();
        assert_eq!(first[0], second[1]);
    }

    #[test]
    fn identical_rows_on_one_day_get_different_ids_and_another_account_gets_its_own() {
        let ids = get_row_ids("acct-1", &[row(json!({})), row(json!({}))]).unwrap();
        assert_ne!(ids[0], ids[1]);
        assert_ne!(get_row_ids("acct-2", &[row(json!({}))]).unwrap()[0], ids[0]);
    }

    #[test]
    fn any_field_that_differs_changes_the_id() {
        let base = get_row_ids("acct-1", &[row(json!({}))]).unwrap();
        let overs = [
            json!({ "date": "2026-03-03" }),
            json!({ "investment": "OTHER" }),
            json!({ "label": "Dividend" }),
            json!({ "amount": 100.01 }),
            json!({ "shares": 2.000001 }),
        ];
        for over in overs {
            assert_ne!(get_row_ids("acct-1", &[row(over)]).unwrap(), base);
        }
    }

    #[test]
    fn row_ids_are_the_typescripts() {
        // `getRowIds("acct-1", [row, row, { ...row, amount: -0.001, shares: -0.0000004 }])` under Bun;
        // the last row's figures print as "-0.00" and "-0.000000".
        let rows = [row(json!({})), row(json!({})), row(json!({ "amount": -0.001, "shares": -0.0000004 }))];
        assert_eq!(
            get_row_ids("acct-1", &rows).unwrap(),
            [
                "plan-af3e9012fce90b34d9023851c874abae",
                "plan-b03ef081a118af50531745ff8b279928",
                "plan-d996dd2b90c8a90a31d9f3b72c3b18f6"
            ]
        );
        assert!(get_row_ids("acct-1", &[json!({ "amount": "100", "shares": 2 })]).is_err());
        assert!(get_row_ids("acct-1", &[json!({ "amount": 100 })]).is_err());
        assert_eq!(get_cash_leg_id("plan-x"), "plan-x-cash");
    }

    #[test]
    fn planned_ids_match_the_pattern() {
        let hash = "0123456789abcdef".repeat(2);
        let id = format!("plan-{hash}");
        for accepted in [id.clone(), format!("{id}-cash"), format!("plan-dividend-{hash}"), format!("plan-dividend-{hash}-cash")] {
            assert!(PLAN_STATEMENT_ID_PATTERN.is_match(&accepted), "{accepted}");
        }
        for refused in [format!("{id}\n"), format!("x{id}"), id.to_uppercase(), format!("{id}-cash-cash"), "plan-".to_string()] {
            assert!(!PLAN_STATEMENT_ID_PATTERN.is_match(&refused), "{refused}");
        }
    }

    fn two_bars() -> Vec<Json> {
        vec![
            json!({ "date": "2026-03-02", "close": 50, "adjustedClose": 49 }),
            json!({ "date": "2026-03-06", "close": 51, "adjustedClose": 50 }),
        ]
    }

    #[test]
    fn a_weekend_date_takes_the_prior_trading_day() {
        assert_eq!(close_on_or_before(&two_bars(), "2026-03-08").unwrap()["date"], "2026-03-06");
    }

    #[test]
    fn nothing_within_a_week_before_the_date_is_no_close() {
        assert!(close_on_or_before(&two_bars(), "2026-03-01").is_none());
        assert!(close_on_or_before(&two_bars(), "2026-03-20").is_none());
        assert_eq!(close_on_or_before(&two_bars(), "2026-03-13").unwrap()["date"], "2026-03-06");
        assert!(close_on_or_before(&two_bars(), "2026-03-14").is_none());
        assert!(close_on_or_before(&[], "2026-03-02").is_none());
    }

    fn drifting_bars() -> Vec<Json> {
        vec![
            json!({ "date": "2026-03-02", "close": 50, "adjustedClose": 40 }),
            json!({ "date": "2026-03-16", "close": 52, "adjustedClose": 42 }),
        ]
    }

    fn flat_bars() -> Vec<Json> {
        vec![
            json!({ "date": "2026-03-02", "close": 50, "adjustedClose": 42 }),
            json!({ "date": "2026-03-16", "close": 52, "adjustedClose": 42 }),
        ]
    }

    #[test]
    fn a_unit_price_that_stays_a_fixed_multiple_of_the_adjusted_close_passes() {
        let rows = [
            row(json!({ "date": "2026-03-02", "amount": 80, "shares": 4 })),
            row(json!({ "date": "2026-03-16", "amount": 84, "shares": 4 })),
        ];
        let result = check_restatement(&rows, &drifting_bars(), "XPUB");
        assert_json(&result["ok"], json!(true));
        assert_close(&result["spread"], 0.0, 10);
    }

    #[test]
    fn drift_past_one_and_a_half_percent_refuses_and_the_check_uses_the_adjusted_close_not_the_raw_one() {
        // 20/40 = 0.5 vs 21.5/42 = 0.5119: 2.4% apart on adjusted closes,
        // but 20/50 = 0.4 vs 21.5/52 = 0.4135 is 3.4% on raw closes.
        let rows = [
            row(json!({ "date": "2026-03-02", "amount": 80, "shares": 4 })),
            row(json!({ "date": "2026-03-16", "amount": 86, "shares": 4 })),
        ];
        let result = check_restatement(&rows, &drifting_bars(), "XPUB");
        assert_json(&result["ok"], json!(false));
        // 2.38% apart nominally; the rounding allowance narrows it only slightly.
        let spread = result["spread"].as_f64().unwrap();
        assert!(spread > 0.023 && spread < 0.0239);
        // What `checkRestatement` answers under Bun.
        assert_json(
            &result,
            json!({ "ok": false, "spread": 0.023430130105057456, "message": "Unit price drifts 2.34% against XPUB, more than 1.5%" }),
        );
    }

    #[test]
    fn small_rows_whose_rounding_alone_moves_the_unit_price_past_the_band_arent_measured() {
        // $2.10 at 0.041 and 0.040 units print 2.5% apart; each row's rounding is
        // over 1%, so neither is measured and the two precise rows decide.
        let rows = [
            row(json!({ "date": "2026-03-02", "amount": -2.1, "shares": -0.041, "shareRounding": 0.0005 })),
            row(json!({ "date": "2026-03-02", "amount": -2.1, "shares": -0.04, "shareRounding": 0.0005 })),
            row(json!({ "date": "2026-03-02", "amount": 103.7, "shares": 2, "shareRounding": 0.0005 })),
            row(json!({ "date": "2026-03-16", "amount": 207.4, "shares": 4, "shareRounding": 0.0005 })),
        ];
        assert_json(&check_restatement(&rows, &flat_bars(), "XPUB")["ok"], json!(true));
    }

    #[test]
    fn whole_share_figures_cant_confirm_a_restatement_even_with_12_percent_drift_hidden_in_them() {
        let coarse = |rounding: f64| {
            [
                row(json!({ "date": "2026-03-02", "amount": 420, "shares": 10, "shareRounding": rounding })),
                row(json!({ "date": "2026-03-02", "amount": 453.6, "shares": 10, "shareRounding": rounding })),
                row(json!({ "date": "2026-03-16", "amount": 470.4, "shares": 10, "shareRounding": rounding })),
            ]
        };
        assert_json(
            &check_restatement(&coarse(0.5), &flat_bars(), "XPUB"),
            json!({
                "ok": false,
                "spread": null,
                "message": "Too few rows give shares precisely enough to check the restatement (0 of 3)",
            }),
        );
        // The same rows printed to three decimals are measured, and refused for the drift.
        let precise = check_restatement(&coarse(0.0005), &flat_bars(), "XPUB");
        assert_json(&precise["ok"], json!(false));
        assert!(precise["spread"].as_f64().unwrap() > 0.11);
    }

    #[test]
    fn a_row_whose_dollar_amount_is_too_small_to_price_precisely_isnt_measured() {
        let rows = [
            row(json!({ "date": "2026-03-02", "amount": 1.5, "shares": 0.033, "shareRounding": 0.0000005 })),
            row(json!({ "date": "2026-03-02", "amount": 103.7, "shares": 2, "shareRounding": 0.0005 })),
            row(json!({ "date": "2026-03-16", "amount": 207.4, "shares": 4, "shareRounding": 0.0005 })),
        ];
        assert_json(&check_restatement(&rows, &flat_bars(), "XPUB")["ok"], json!(true));
    }

    #[test]
    fn one_measurable_row_confirms_nothing() {
        let rows = [row(json!({ "date": "2026-03-02", "amount": 103.7, "shares": 2, "shareRounding": 0.0005 }))];
        assert_json(
            &check_restatement(&rows, &flat_bars(), "XPUB"),
            json!({
                "ok": false,
                "spread": null,
                "message": "Too few rows give shares precisely enough to check the restatement (1 of 1)",
            }),
        );
    }

    #[test]
    fn a_row_with_no_close_near_its_date_refuses() {
        assert_json(
            &check_restatement(&[row(json!({ "date": "2026-02-01" }))], &drifting_bars(), "XPUB"),
            json!({ "ok": false, "spread": null, "message": "No XPUB close on or just before 2026-02-01" }),
        );
    }

    #[test]
    fn a_contribution_writes_a_buy_and_a_cash_row_arriving_both_from_the_statements_figures() {
        let plan = Input { rows: vec![row(json!({ "amount": 1234.56, "shares": 9.876 }))], ..Default::default() }.plan();
        assert!(plan.blockers.is_empty());
        let id = plan.rows[0]["id"].as_str().unwrap();
        assert_json(
            &Json::Array(plan.transactions.clone()),
            json!([
                {
                    "transaction": {
                        "investment_transaction_id": id,
                        "account_id": "acct-1",
                        "security_id": "sec-index",
                        "date": "2026-03-02",
                        "name": "Buy (contribution)",
                        "amount": 1234.56,
                        "quantity": 9.876,
                        "price": 1234.56 / 9.876,
                        "iso_currency_code": "USD",
                        "type": "buy",
                        "subtype": "contribution",
                        "source": "manual",
                    },
                },
                {
                    "transaction": {
                        "investment_transaction_id": format!("{id}-cash"),
                        "account_id": "acct-1",
                        "security_id": null,
                        "date": "2026-03-02",
                        "name": "Contribution",
                        "amount": -1234.56,
                        "quantity": 0,
                        "price": 0,
                        "iso_currency_code": "USD",
                        "type": "cash",
                        "subtype": "contribution",
                        "source": "manual",
                    },
                },
            ]),
        );
        assert_json(
            &plan.to_json()["rows"],
            json!([{
                "id": id,
                "line": 1,
                "date": "2026-03-02",
                "investment": "EXAMPLE INDEX FUND",
                "label": "Contributions",
                "amount": 1234.56,
                "shares": 9.876,
                "status": "new",
                "kind": "contribution",
            }]),
        );
        assert_json(
            &plan.to_json()["funds"],
            json!([{ "investment": "EXAMPLE INDEX FUND", "mapping": index_fund(), "newRows": 1 }]),
        );
    }

    #[test]
    fn a_fee_sells_shares_and_its_cash_row_leaves_the_account() {
        let rows = vec![row(json!({ "label": "Advisor Fee", "amount": -4, "shares": -0.08 }))];
        let plan = Input { rows, ..Default::default() }.plan();
        let (sell, cash) = (&plan.transactions[0]["transaction"], &plan.transactions[1]["transaction"]);
        assert_json(
            &json!([sell["type"], sell["subtype"], sell["amount"], sell["quantity"]]),
            json!(["sell", "management fee", -4, -0.08]),
        );
        assert_close(&sell["price"], 50.0, 10);
        assert_json(&json!([cash["type"], cash["subtype"], cash["amount"]]), json!(["cash", "management fee", 4]));
    }

    #[test]
    fn a_restated_fund_buys_the_public_funds_shares_at_its_raw_close_and_keeps_the_statements_units() {
        let rows = vec![
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-02", "amount": 80, "shares": 4 })),
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-16", "amount": 84, "shares": 4 })),
        ];
        let plan = Input::trust(rows, drifting_bars()).plan();
        assert!(plan.blockers.is_empty());
        let buys = of_type(&plan, "buy");
        let field = |key: &str| -> Json { buys.iter().map(|t| t["transaction"][key].clone()).collect() };
        assert_json(&field("security_id"), json!(["sec-public", "sec-public"]));
        assert_json(&field("price"), json!([50, 52]));
        assert_json(&field("amount"), json!([80, 84]));
        assert_close(&buys[0]["transaction"]["quantity"], 1.6, 10);
        assert_close(&buys[1]["transaction"]["quantity"], 84.0 / 52.0, 10);
        assert_json(
            &buys.iter().map(|t| t["restated_from"].clone()).collect(),
            json!([
                { "investment": "EXAMPLE TRUST", "units": 4, "unit_price": 20 },
                { "investment": "EXAMPLE TRUST", "units": 4, "unit_price": 21 },
            ]),
        );
        assert!(of_type(&plan, "cash").iter().all(|t| t.get("restated_from").is_none()));
    }

    #[test]
    fn a_restated_fund_that_drifts_from_its_public_fund_blocks_the_import_and_writes_nothing() {
        let rows = vec![
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-02", "amount": 80, "shares": 4 })),
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-16", "amount": 90, "shares": 4 })),
        ];
        let plan = Input::trust(rows, drifting_bars()).plan();
        assert!(plan.transactions.is_empty());
        assert_eq!(plan.blockers, ["EXAMPLE TRUST can't be restated: Unit price drifts 7.10% against XPUB, more than 1.5%"]);
    }

    #[test]
    fn a_failed_closes_fetch_names_its_reason_on_the_fund_and_in_the_blocker() {
        let plan = Input {
            rows: vec![row(json!({ "investment": "EXAMPLE TRUST" }))],
            mappings: IndexMap::from([("EXAMPLE TRUST".to_string(), trust())]),
            close_errors: Some(IndexMap::from([(
                "EXAMPLE TRUST".to_string(),
                json!({ "message": "Market data is busy right now", "retryable": true }),
            )])),
            ..Default::default()
        }
        .plan();
        assert_json(
            &plan.funds[0]["restatement"],
            json!({ "ok": false, "spread": null, "message": "Market data is busy right now", "retryable": true }),
        );
        assert_eq!(plan.blockers, ["EXAMPLE TRUST can't be restated: Market data is busy right now"]);
    }

    #[test]
    fn a_restated_fund_needs_a_ticker_and_closes() {
        let no_closes = Input::trust(vec![row(json!({ "investment": "EXAMPLE TRUST" }))], Vec::new()).plan();
        assert_json(
            &no_closes.funds[0]["restatement"],
            json!({ "ok": false, "spread": null, "message": "No XPUB closes for the statement's dates" }),
        );
        let no_ticker = Input {
            mappings: IndexMap::from([(
                "EXAMPLE TRUST".to_string(),
                json!({ "security_id": "sec-public", "restated": true, "ticker_symbol": null }),
            )]),
            ..Input::trust(vec![row(json!({ "investment": "EXAMPLE TRUST" }))], drifting_bars())
        }
        .plan();
        assert_eq!(no_ticker.blockers, ["EXAMPLE TRUST can't be restated: A restated fund needs a security with a ticker"]);
    }

    #[test]
    fn rows_already_in_the_account_are_listed_as_imported_and_not_written_again() {
        let rows = vec![row(json!({ "date": "2026-03-02" })), row(json!({ "date": "2026-03-16" }))];
        let first_id = get_row_ids("acct-1", &rows).unwrap().remove(0);
        let plan = Input { rows, existing_ids: IndexSet::from([first_id]), ..Default::default() }.plan();
        assert_eq!(statuses(&plan), ["imported", "new"]);
        assert_json(&plan.rows[0]["needsDecision"], json!(false));
        let dates: Json = plan.transactions.iter().map(|t| t["transaction"]["date"].clone()).collect();
        assert_json(&dates, json!(["2026-03-16", "2026-03-16"]));
    }

    #[test]
    fn a_row_that_needs_a_decision_blocks_the_import_until_the_user_makes_one() {
        let rows = vec![row(json!({ "label": "Withdrawals", "amount": -500, "shares": -10 }))];
        let undecided = Input { rows: rows.clone(), ..Default::default() }.plan();
        assert_eq!(statuses(&undecided), ["decide"]);
        assert_eq!(undecided.blockers, ["1 row needs a decision"]);
        assert!(undecided.transactions.is_empty());

        let id = undecided.rows[0]["id"].as_str().unwrap();
        let decided =
            |decision: &str| Input { rows: rows.clone(), decisions: json!({ id: decision }), ..Default::default() }.plan();
        let leaves = decided("withdrawal_out");
        assert!(leaves.blockers.is_empty());
        let legs: Json = leaves
            .transactions
            .iter()
            .map(|t| json!([t["transaction"]["type"], t["transaction"]["subtype"], t["transaction"]["amount"]]))
            .collect();
        assert_json(&legs, json!([["sell", "sell", -500], ["cash", "withdrawal", 500]]));

        let stays = decided("withdrawal_kept");
        assert_eq!(stays.transactions.len(), 1);
        assert_json(&stays.transactions[0]["transaction"]["type"], json!("sell"));

        let skipped = decided("skip");
        assert_json(
            &skipped.rows[0],
            json!({
                "id": id,
                "line": 1,
                "date": "2026-03-02",
                "investment": "EXAMPLE INDEX FUND",
                "label": "Withdrawals",
                "amount": -500,
                "shares": -10,
                "needsDecision": true,
                "allowedDecisions": ["fee", "withdrawal_out", "withdrawal_kept", "skip"],
                "status": "skip",
                "reason": "Skipped by you",
            }),
        );
        assert!(skipped.transactions.is_empty());
    }

    #[test]
    fn a_reversed_contribution_is_left_to_the_user_who_cant_book_it_as_a_contribution() {
        let rows = vec![row(json!({ "amount": -100, "shares": -2 }))];
        let plan = Input { rows: rows.clone(), ..Default::default() }.plan();
        assert_json(&json!([plan.rows[0]["status"], plan.rows[0]["needsDecision"]]), json!(["decide", true]));
        assert_json(&plan.rows[0]["allowedDecisions"], json!(["fee", "withdrawal_out", "withdrawal_kept", "skip"]));
        assert_json(&plan.rows[0]["reason"], json!("The figures point the other way from a contribution"));

        let id = plan.rows[0]["id"].as_str().unwrap();
        let forced = Input { rows, decisions: json!({ id: "contribution" }), ..Default::default() }.plan();
        assert_eq!(statuses(&forced), ["decide"]);
        assert!(forced.transactions.is_empty());
    }

    #[test]
    fn an_amount_and_shares_of_opposite_signs_can_only_be_skipped() {
        let plan = Input { rows: vec![row(json!({ "amount": 100, "shares": -2 }))], ..Default::default() }.plan();
        assert_json(&plan.rows[0]["allowedDecisions"], json!(["skip"]));
    }

    fn trust_rows_with_a_gain() -> Vec<Json> {
        vec![
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-02", "amount": 80, "shares": 4 })),
            row(json!({ "investment": "EXAMPLE TRUST", "date": "2026-03-16", "amount": 84, "shares": 4 })),
            row(json!({
                "investment": "EXAMPLE TRUST",
                "date": "2026-03-16",
                "label": "Realized Gain/Loss",
                "amount": 3.1,
                "shares": 0.5,
            })),
        ]
    }

    #[test]
    fn the_band_measures_only_the_rows_being_written_so_a_skipped_row_with_shares_doesnt_block() {
        let undecided = Input::trust(trust_rows_with_a_gain(), drifting_bars()).plan();
        assert_eq!(undecided.blockers, ["1 row needs a decision"]);
        let gain_id = undecided.rows[2]["id"].as_str().unwrap();
        let skipped =
            Input { decisions: json!({ gain_id: "skip" }), ..Input::trust(trust_rows_with_a_gain(), drifting_bars()) }.plan();
        assert!(skipped.blockers.is_empty());
        assert_json(&skipped.funds[0]["restatement"]["ok"], json!(true));
        assert_eq!(of_type(&skipped, "buy").len(), 2);
    }

    #[test]
    fn the_band_counts_the_rows_this_statement_already_wrote_so_one_new_row_can_still_be_checked() {
        let rows = trust_rows_with_a_gain()[..2].to_vec();
        let imported_id = get_row_ids("acct-1", &rows).unwrap().remove(0);
        let plan = Input { existing_ids: IndexSet::from([imported_id]), ..Input::trust(rows, drifting_bars()) }.plan();
        assert_eq!(statuses(&plan), ["imported", "new"]);
        assert_json(&plan.funds[0]["restatement"]["ok"], json!(true));
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn a_decision_cant_override_a_row_the_rules_already_classify() {
        let rows = vec![row(json!({}))];
        let id = get_row_ids("acct-1", &rows).unwrap().remove(0);
        let plan = Input { rows, decisions: json!({ id: "skip" }), ..Default::default() }.plan();
        assert_eq!(statuses(&plan), ["new"]);
        assert_eq!(plan.transactions.len(), 2);
    }

    #[test]
    fn a_fund_with_new_rows_and_no_mapping_blocks_the_import() {
        let plan = Input { rows: vec![row(json!({ "investment": "UNMAPPED FUND" }))], ..Default::default() }.plan();
        assert_eq!(plan.blockers, ["Map UNMAPPED FUND to a security"]);
        assert_json(
            &Json::Array(plan.funds.clone()),
            json!([{ "investment": "UNMAPPED FUND", "mapping": null, "newRows": 1 }]),
        );
        assert!(plan.transactions.is_empty());
    }

    #[test]
    fn an_unmapped_fund_whose_rows_are_all_imported_or_skipped_doesnt_block() {
        let rows = vec![row(json!({ "investment": "UNMAPPED FUND", "label": "Transfers", "amount": 0, "shares": 0 }))];
        assert!(Input { rows, ..Default::default() }.plan().blockers.is_empty());
    }

    #[test]
    fn several_undecided_rows_and_funds_block_in_the_order_the_statement_names_them() {
        let rows = vec![
            row(json!({ "label": "Loan", "investment": "B" })),
            row(json!({ "label": "Loan", "investment": "A" })),
            row(json!({ "investment": "B" })),
            row(json!({ "investment": "A" })),
        ];
        let plan = Input { rows, ..Default::default() }.plan();
        assert_eq!(plan.blockers, ["2 rows need a decision", "Map B to a security", "Map A to a security"]);
        let funds: Json = plan.funds.iter().map(|fund| json!([fund["investment"], fund["newRows"]])).collect();
        assert_json(&funds, json!([["B", 1], ["A", 1]]));
    }
}
