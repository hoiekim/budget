//! Finds recurring bills and income in settled transactions, and keeps
//! confirmed recurrings collecting their new charges:
//! `src/server/lib/compute-tools/detect-recurrings.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::json;

use crate::common::constants::RECURRINGS;
use crate::ctx;
use crate::filters;
use crate::js::{math_round, truthy_opt, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Client, Executor};
use crate::server::postgres::database::SearchFilters;
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::common::{
    CADENCE, IS_DELETED, IS_INCOME, MERCHANT_KEY, MERCHANT_NAME, RECURRING_ID, STATUS, TRANSACTION_IDS, UPDATED, USER_ID,
};
use crate::server::postgres::models::{recurring, user, Row};
use crate::server::postgres::repositories::recurrings::label_confirmed_recurring;

/// Minimum settled occurrences in a run before it counts as a recurring.
const MIN_OCCURRENCES: usize = 3;
/// A run that starts after the merchant's first charge needs one more:
/// three roughly monthly visits to a shop with an irregular history are more
/// likely chance than a bill.
const MIN_OCCURRENCES_AFTER_EARLIER_CHARGES: usize = 4;
/// Every charge in a run must land within ±25% of the run's median amount.
/// Bills like utilities legitimately vary; tighter than this drops real
/// recurrings, looser admits coincidental same-merchant spending.
const AMOUNT_TOLERANCE_RATIO: f64 = 0.25;
/// A group whose most recent occurrence is older than 2× its cadence is
/// treated as lapsed (cancelled subscription, switched provider, …) and
/// excluded: the surface is "what recurs now", not history.
const LAPSED_CADENCE_MULTIPLE: f64 = 2.0;
/// A merchant's charges split into amount clusters wherever two neighbours
/// (sorted by amount) differ by more than this ratio, so a fee or a second
/// plan billed under the same merchant can't break the main bill's run. It is
/// the widest gap a set within ±25% of its median can contain, so any run that
/// passes the amount check sits inside one cluster.
const MAX_CLUSTER_STEP: f64 = (1.0 + AMOUNT_TOLERANCE_RATIO) / (1.0 - AMOUNT_TOLERANCE_RATIO);
/// How far a confirmed recurring's next charge may move from its latest
/// amount and still count as the same bill at a new price ($10 → $20 or $5).
/// Wider starts admitting unrelated purchases at store-like merchants; a
/// bigger jump (an intro price ending) takes one manual "add to recurring",
/// after which the ±25% rule tracks the new price.
const REPRICE_MAX_FACTOR: f64 = 2.0;

/// One cadence the detector recognizes: its period in days and how far an
/// interval may stray from it.
#[derive(Debug, PartialEq)]
pub struct CadenceSpec {
    /// A `RecurringCadence`.
    pub cadence: &'static str,
    pub days: f64,
    pub tolerance_days: f64,
}

pub static CADENCE_SPECS: [CadenceSpec; 6] = [
    CadenceSpec { cadence: "weekly", days: 7.0, tolerance_days: 2.0 },
    CadenceSpec { cadence: "biweekly", days: 14.0, tolerance_days: 3.0 },
    CadenceSpec { cadence: "monthly", days: 30.44, tolerance_days: 5.0 },
    CadenceSpec { cadence: "quarterly", days: 91.31, tolerance_days: 10.0 },
    CadenceSpec { cadence: "semiannual", days: 182.62, tolerance_days: 15.0 },
    CadenceSpec { cadence: "annual", days: 365.25, tolerance_days: 30.0 },
];

/// Domain-suffix tokens Plaid appends to web-billed merchants ("NETFLIX.COM"
/// vs "Netflix"). Stripped only in trailing position, so a merchant genuinely
/// named e.g. "Comcast" (leading token) is untouched.
const DOMAIN_SUFFIX_TOKENS: [&str; 3] = ["com", "net", "org"];

/// A zero-padded MM/DD or MM/DD/YY(YY) date that banks append to names. Word
/// boundaries and digits are ASCII, as in a JavaScript pattern without `u`.
static NAME_DATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:0[1-9]|1[0-2])/(?:0[1-9]|[12][0-9]|3[01])(?:/[0-9]{2}(?:[0-9]{2})?)?(?-u:\b)").unwrap()
});

/// What JavaScript's `\s` matches: white space, line terminators and the BOM.
const JS_WHITE_SPACE: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// Anything but a letter, a digit or white space.
static PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^\p{{L}}\p{{N}}{JS_WHITE_SPACE}]")).unwrap());

static WHITE_SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{JS_WHITE_SPACE}]+")).unwrap());

static LONG_DIGIT_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{5,}$").unwrap());

/// Normalize a merchant display string into a grouping key. Plaid merchant
/// names carry per-charge noise (domain suffixes "NETFLIX.COM", phone-number
/// suffixes "Netflix 8665795717", posting dates "Manual DB-Bkrg 07/03",
/// punctuation, case drift), so the key drops dates, lowercases, drops
/// punctuation, drops long digit runs (reference/phone numbers) while keeping
/// short ones ("7-Eleven" keeps its 7), and drops trailing domain-suffix
/// tokens.
pub fn normalize_merchant_name(raw: &str) -> String {
    let without_dates = NAME_DATE_PATTERN.replace_all(raw, " ");
    let lowered = without_dates.to_lowercase();
    let cleaned = PUNCTUATION.replace_all(&lowered, " ");
    let mut tokens: Vec<&str> =
        WHITE_SPACE_RUN.split(&cleaned).filter(|token| !token.is_empty() && !LONG_DIGIT_RUN.is_match(token)).collect();
    while tokens.len() > 1 && tokens.last().is_some_and(|token| DOMAIN_SUFFIX_TOKENS.contains(token)) {
        tokens.pop();
    }
    tokens.join(" ")
}

/// Whether a bank description contains the whole merchant key, word for word.
fn description_names(name: &str, key: &str) -> bool {
    format!(" {} ", normalize_merchant_name(name)).contains(&format!(" {key} "))
}

/// One settled transaction the detector considers, the TypeScript
/// `RecurringCandidate`. A recurring's members take the same shape, with no
/// `name`.
#[derive(Clone, Debug, PartialEq)]
pub struct RecurringCandidate {
    pub transaction_id: String,
    /// Plaid sign convention: positive = money out, negative = money in.
    pub amount: f64,
    /// YYYY-MM-DD (the transaction's effective date).
    pub date: String,
    pub merchant_name: Option<String>,
    pub name: Option<String>,
}

impl RecurringCandidate {
    /// `merchant_name || name`: the first of them that is not empty.
    fn display_name(&self) -> Option<&str> {
        [&self.merchant_name, &self.name].into_iter().flatten().map(String::as_str).find(|text| !text.is_empty())
    }

    /// The merchant group it keys into.
    fn merchant_key(&self) -> String {
        normalize_merchant_name(self.display_name().unwrap_or(""))
    }
}

/// A merchant and direction found recurring, the TypeScript `DetectedRecurringGroup`.
#[derive(Clone, Debug, PartialEq)]
pub struct DetectedRecurringGroup {
    pub merchant_key: String,
    pub merchant_name: String,
    /// A `RecurringCadence`.
    pub cadence: &'static str,
    pub is_income: bool,
    /// transaction_ids, oldest first.
    pub transaction_ids: Vec<String>,
}

fn median_of_sorted(sorted: &[f64]) -> f64 {
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

/// `new Date(date + "T00:00:00")`: local midnight of a `YYYY-MM-DD`.
fn local_midnight(date: &str) -> JsDate {
    JsDate::parse(&format!("{date}T00:00:00"))
}

fn days_between(a: &str, b: &str) -> f64 {
    math_round((local_midnight(b).get_time() - local_midnight(a).get_time()) / 86_400_000.0)
}

fn is_valid_date(date: &str) -> bool {
    local_midnight(date).is_valid()
}

/// Is `amount` within `ratio` of `reference`, by magnitude?
fn amount_within(amount: f64, reference: f64, ratio: f64) -> bool {
    (amount.abs() - reference.abs()).abs() <= reference.abs() * ratio
}

/// `!amount`: zero and NaN are falsy.
fn is_zero(amount: f64) -> bool {
    amount == 0.0 || amount.is_nan()
}

fn most_common(values: &[&str]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut best = values.first().copied().unwrap_or("");
    let mut best_count = 0;
    for value in values {
        let count = counts.entry(value).or_insert(0);
        *count += 1;
        if *count > best_count {
            best_count = *count;
            best = value;
        }
    }
    best.to_string()
}

/// Sorts oldest first, keeping same-day entries in their order.
fn sort_by_date(list: &mut [&RecurringCandidate]) {
    list.sort_by(|a, b| a.date.cmp(&b.date));
}

struct QualifyingRun<'a> {
    spec: &'static CadenceSpec,
    /// Oldest first.
    occurrences: Vec<&'a RecurringCandidate>,
    median_amount: f64,
}

/// Split one merchant's occurrences into amount clusters: sorted by
/// magnitude, a new cluster starts wherever a neighbour is more than
/// `MAX_CLUSTER_STEP` larger.
fn cluster_by_amount<'a>(occurrences: &[&'a RecurringCandidate]) -> Vec<Vec<&'a RecurringCandidate>> {
    let mut by_amount = occurrences.to_vec();
    by_amount.sort_by(|a, b| a.amount.abs().partial_cmp(&b.amount.abs()).unwrap_or(std::cmp::Ordering::Equal));
    let mut clusters = Vec::new();
    let mut current: Vec<&RecurringCandidate> = Vec::new();
    for o in by_amount {
        if let Some(previous) = current.last() {
            if o.amount.abs() > previous.amount.abs() * MAX_CLUSTER_STEP {
                clusters.push(std::mem::take(&mut current));
            }
        }
        current.push(o);
    }
    if !current.is_empty() {
        clusters.push(current);
    }
    clusters
}

/// The longest run of a cluster's most recent occurrences that qualifies as a
/// recurring, or `None`. A run ends at the latest occurrence, has ≥3
/// occurrences (≥4 when the merchant has older charges at any price), every
/// consecutive interval within tolerance of one cadence, every amount within
/// ±25% of the run's median, and its latest occurrence within 2× the cadence
/// of `today`. Anything older than the run (a gap, a price that has since
/// changed, a mislabelled charge) is left out rather than disqualifying the
/// merchant.
fn latest_qualifying_run<'a>(sorted_by_date: &[&'a RecurringCandidate], merchant_first_date: &str, today: &str) -> Option<QualifyingRun<'a>> {
    let len = sorted_by_date.len();
    let last = sorted_by_date.last()?;
    if len < MIN_OCCURRENCES {
        return None;
    }
    let mut best: Option<QualifyingRun<'a>> = None;
    for spec in &CADENCE_SPECS {
        if days_between(&last.date, today) > spec.days * LAPSED_CADENCE_MULTIPLE {
            continue;
        }
        let mut start = len - 1;
        while start > 0
            && (days_between(&sorted_by_date[start - 1].date, &sorted_by_date[start].date) - spec.days).abs() <= spec.tolerance_days
        {
            start -= 1;
        }
        let minimum_at = |from: usize| {
            if sorted_by_date[from].date.as_str() > merchant_first_date {
                MIN_OCCURRENCES_AFTER_EARLIER_CHARGES
            } else {
                MIN_OCCURRENCES
            }
        };
        let mut from = start;
        while len - from >= minimum_at(from) {
            if best.as_ref().is_some_and(|best| len - from <= best.occurrences.len()) {
                break;
            }
            let occurrences = sorted_by_date[from..].to_vec();
            let abs_amounts: Vec<f64> = occurrences.iter().map(|o| o.amount.abs()).collect();
            let mut sorted_amounts = abs_amounts.clone();
            sorted_amounts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median_amount = median_of_sorted(&sorted_amounts);
            if abs_amounts.iter().all(|a| amount_within(*a, median_amount, AMOUNT_TOLERANCE_RATIO)) {
                best = Some(QualifyingRun { spec, occurrences, median_amount });
                break;
            }
            from += 1;
        }
    }
    best
}

/// Group candidate transactions into recurring groups. Pure: the caller owns
/// candidate selection (pending/zero-amount/hidden-account/confirmed-transfer
/// filtering); this only groups and qualifies.
///
/// Occurrences group by merchant and direction (income and expense of the
/// same merchant are separate), then split into amount clusters. A merchant
/// becomes a recurring when one of its clusters has a qualifying run (see
/// `latest_qualifying_run`); the group holds that run's occurrences. When
/// several clusters qualify, the larger amount wins, so a monthly fee billed
/// beside the rent never displaces it: one merchant and direction holds at
/// most one recurring.
///
/// `now` decides the recency check; "today" is its UTC calendar day.
pub fn detect_recurring_groups(candidates: &[RecurringCandidate], now: JsDate) -> Vec<DetectedRecurringGroup> {
    let today: String = now.to_iso_string().unwrap_or_default().chars().take(10).collect();
    let mut groups: IndexMap<String, Vec<&RecurringCandidate>> = IndexMap::new();
    for t in candidates {
        if is_zero(t.amount) {
            continue;
        }
        let key = t.merchant_key();
        if key.is_empty() {
            continue;
        }
        if !is_valid_date(&t.date) {
            continue;
        }
        // Direction split: the same merchant can bill and pay (marketplace
        // payouts vs. purchases), and those are different recurrings.
        let group_key = format!("{key}::{}", if t.amount < 0.0 { "in" } else { "out" });
        groups.entry(group_key).or_default().push(t);
    }

    let mut result = Vec::new();
    for occurrences in groups.values() {
        if occurrences.len() < MIN_OCCURRENCES {
            continue;
        }

        let merchant_first_date =
            occurrences.iter().fold(occurrences[0].date.as_str(), |first, o| if o.date.as_str() < first { &o.date } else { first });
        let mut best: Option<QualifyingRun> = None;
        for mut cluster in cluster_by_amount(occurrences) {
            sort_by_date(&mut cluster);
            if let Some(run) = latest_qualifying_run(&cluster, merchant_first_date, &today) {
                if best.as_ref().is_none_or(|best| run.median_amount > best.median_amount) {
                    best = Some(run);
                }
            }
        }
        let Some(best) = best else { continue };

        let first = best.occurrences[0];
        let names: Vec<&str> = best.occurrences.iter().map(|o| o.display_name().unwrap_or("")).collect();
        result.push(DetectedRecurringGroup {
            merchant_key: first.merchant_key(),
            merchant_name: most_common(&names),
            cadence: best.spec.cadence,
            is_income: first.amount < 0.0,
            transaction_ids: best.occurrences.iter().map(|o| o.transaction_id.clone()).collect(),
        });
    }

    result
}

/// A confirmed recurring as `select_confirmed_attachments` sees it, the
/// TypeScript `ConfirmedRecurringSnapshot`.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmedRecurringSnapshot {
    pub merchant_key: String,
    pub is_income: bool,
    /// A `RecurringCadence`, as stored.
    pub cadence: String,
    /// The recurring's live member transactions, any order. Only their id,
    /// amount, date and merchant name are read.
    pub members: Vec<RecurringCandidate>,
}

/// The cadence a recurring actually bills on: measured from its members'
/// median interval when that lands on a known cadence, else the stored one.
/// A manual recurring stores a monthly default until it has two members.
fn measured_spec(members: &[&RecurringCandidate], stored: &str) -> Option<&'static CadenceSpec> {
    if members.len() >= 2 {
        let mut intervals: Vec<f64> = members.windows(2).map(|pair| days_between(&pair[0].date, &pair[1].date)).collect();
        intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = median_of_sorted(&intervals);
        if let Some(measured) = CADENCE_SPECS.iter().find(|s| (median - s.days).abs() <= s.tolerance_days) {
            return Some(measured);
        }
    }
    CADENCE_SPECS.iter().find(|s| s.cadence == stored)
}

/// The local day `days` (rounded) after `date`, as `YYYY-MM-DD`.
fn add_days(date: &str, days: f64) -> String {
    let d = local_midnight(date);
    let d = d.set_date(d.get_date() + math_round(days) as i64);
    if !d.is_valid() {
        return "NaN-NaN-NaN".to_string();
    }
    format!("{}-{:02}-{:02}", d.get_full_year(), d.get_month() + 1, d.get_date())
}

/// Where a charge falls on a recurring's schedule.
#[derive(Clone, Copy)]
struct Timing {
    periods: f64,
    offset: f64,
    spec: &'static CadenceSpec,
}

/// Pick the charges a confirmed recurring collects this run. Pure: the caller
/// resolves the members, `claimed` (transaction ids already in any active
/// recurring, this one included), and `group`, the transaction ids of this
/// merchant's detection group (its latest qualifying run) when it has one.
///
/// Two sources, returned together, oldest first:
///
/// 1. The qualifying group, when it holds one of the recurring's members;
///    otherwise it is another stream the merchant bills, at another price.
///    Every unclaimed charge in it joins, whatever its date: detection has
///    already checked the intervals and amounts. This is how a recurring
///    created from one recent charge picks up its history, and how a charge
///    that syncs late with an earlier date still lands.
///
/// 2. New charges after the latest member, for when no qualifying group holds
///    one (one late charge, a price change, a stray purchase). Walking forward
///    one billing cycle at a time, a charge joins when it is due on the
///    schedule and looks like the bill:
///    - Due: a whole number of periods after the last due date, no more than
///      the cadence's tolerance early and at most half a period late. A late
///      charge moves the schedule to its due date, not its own, so the next
///      on-time charge still fits. Among several due charges in a cycle, the
///      one closest to the due date wins, so a same-priced purchase a few
///      days off can't push the real charge out.
///    - Bill-like: within ±25% of the latest member's amount, or the same bill
///      at a new price (within 2×, on time, and repeated one period later at
///      ±25%, so the first new-price charge joins a cycle late).
///
///    A recurring with a single member has no measured cadence yet, so its
///    next charge joins when it lands one period of any cadence later (on
///    time); after that the measured schedule applies.
pub fn select_confirmed_attachments(
    recurring: &ConfirmedRecurringSnapshot,
    candidates: &[RecurringCandidate],
    claimed: &HashSet<String>,
    group: Option<&[String]>,
    active_keys: &HashSet<String>,
) -> Vec<String> {
    let key = recurring.merchant_key.as_str();
    // Enrichment can name a merchant something else, or nothing, from one
    // charge to the next, so a bank description that names this merchant also
    // counts. Only for a key that came from a merchant name and has more than
    // one word: a key formed from a description, or a single word, also
    // matches whatever else bills through it. A charge whose own key is
    // another active recurring's stays with that one.
    let describable = key.contains(' ')
        && recurring.members.iter().any(|m| {
            m.merchant_name.as_deref().is_some_and(|name| !name.is_empty() && normalize_merchant_name(name) == key)
        });
    let belongs = |c: &RecurringCandidate| {
        let own = c.merchant_key();
        if own == key {
            return true;
        }
        describable
            && c.name.as_deref().is_some_and(|name| !name.is_empty() && !active_keys.contains(&own) && description_names(name, key))
    };
    let candidate_by_id: HashMap<&str, &RecurringCandidate> = candidates.iter().map(|c| (c.transaction_id.as_str(), c)).collect();
    let member_ids: HashSet<&str> = recurring.members.iter().map(|m| m.transaction_id.as_str()).collect();
    let group_ids: &[String] = group.unwrap_or(&[]);
    let same_stream = group_ids.iter().any(|id| member_ids.contains(id.as_str()));
    let from_group: Vec<&RecurringCandidate> = if same_stream {
        group_ids.iter().filter(|id| !claimed.contains(*id)).filter_map(|id| candidate_by_id.get(id.as_str()).copied()).collect()
    } else {
        Vec::new()
    };
    let mut taken: HashSet<&str> = claimed.iter().map(String::as_str).collect();
    taken.extend(from_group.iter().map(|c| c.transaction_id.as_str()));
    let mut members: Vec<&RecurringCandidate> = recurring
        .members
        .iter()
        .chain(from_group.iter().copied())
        .filter(|m| !is_zero(m.amount) && is_valid_date(&m.date))
        .collect();
    sort_by_date(&mut members);
    let Some(mut most_recent) = members.last().copied() else { return Vec::new() };

    let mut eligible: Vec<&RecurringCandidate> = candidates
        .iter()
        .filter(|c| {
            !is_zero(c.amount)
                && (c.amount < 0.0) == recurring.is_income
                && !taken.contains(c.transaction_id.as_str())
                && is_valid_date(&c.date)
                && c.date > most_recent.date
                && belongs(c)
        })
        .collect();
    sort_by_date(&mut eligible);

    let mut attached: Vec<&RecurringCandidate> = Vec::new();
    let mut schedule = most_recent.date.clone();
    loop {
        let known: Vec<&RecurringCandidate> = members.iter().chain(attached.iter()).copied().collect();
        let measured = if known.len() >= 2 { measured_spec(&known, &recurring.cadence) } else { None };
        if known.len() >= 2 && measured.is_none() {
            break;
        }

        // Where `date` falls on the schedule from `from`, or `None` if it isn't
        // due: at most `late` days late, never more than tolerance early.
        let due = |from: &str, date: &str, late: f64| -> Option<Timing> {
            let gap = days_between(from, date);
            if let Some(measured) = measured {
                let periods = math_round(gap / measured.days).max(1.0);
                let offset = gap - periods * measured.days;
                return (offset >= -measured.tolerance_days && offset <= late).then_some(Timing {
                    periods,
                    offset,
                    spec: measured,
                });
            }
            // One member: no cadence to go by yet, so take a charge one period
            // of any cadence later.
            CADENCE_SPECS.iter().find_map(|spec| {
                let offset = gap - spec.days;
                (offset.abs() <= spec.tolerance_days).then_some(Timing { periods: 1.0, offset, spec })
            })
        };
        let late_allowance = measured.map(|measured| measured.tolerance_days.max(measured.days / 2.0)).unwrap_or(0.0);

        let mut best: Option<(&RecurringCandidate, Timing)> = None;
        for (i, c) in eligible.iter().enumerate() {
            if c.date <= most_recent.date {
                continue;
            }
            let Some(timing) = due(&schedule, &c.date, late_allowance) else { continue };
            let on_time = timing.offset.abs() <= timing.spec.tolerance_days;
            let same_bill = amount_within(c.amount, most_recent.amount, AMOUNT_TOLERANCE_RATIO);
            let factor = c.amount.abs() / most_recent.amount.abs();
            let repriced = !same_bill
                && on_time
                && (1.0 / REPRICE_MAX_FACTOR..=REPRICE_MAX_FACTOR).contains(&factor)
                && eligible[i + 1..].iter().any(|next| {
                    let gap = days_between(&c.date, &next.date);
                    (gap - timing.spec.days).abs() <= timing.spec.tolerance_days
                        && amount_within(next.amount, c.amount, AMOUNT_TOLERANCE_RATIO)
                });
            if !same_bill && !repriced {
                continue;
            }
            let better = match &best {
                None => true,
                Some((_, held)) => {
                    timing.periods < held.periods || (timing.periods == held.periods && timing.offset.abs() < held.offset.abs())
                }
            };
            if better {
                best = Some((c, timing));
            }
        }
        let Some((charge, timing)) = best else { break };
        attached.push(charge);
        most_recent = charge;
        // A late charge keeps the schedule on its due date, so the next
        // on-time charge still fits.
        schedule = if timing.offset.abs() > timing.spec.tolerance_days {
            add_days(&schedule, timing.periods * timing.spec.days)
        } else {
            charge.date.clone()
        };
    }

    let mut picked: Vec<&RecurringCandidate> = from_group.into_iter().chain(attached).collect();
    sort_by_date(&mut picked);
    picked.into_iter().map(|c| c.transaction_id.clone()).collect()
}

/// `Number(value)` for a column value.
pub(super) fn number_of(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(s)) => crate::js::to_number(s),
        Some(_) => f64::NAN,
    }
}

/// A text column, `None` when null.
fn text_of(row: &Obj, column: &str) -> Option<String> {
    row.get(column).and_then(|value| value.as_str()).map(str::to_string)
}

/// `(row.date as string).slice(0, 10)`.
fn date_of(row: &Obj) -> String {
    str_of(row, "date").chars().take(10).collect()
}

async fn fetch_candidates(user_id: &str, executor: &dyn Executor) -> anyhow::Result<Vec<RecurringCandidate>> {
    // Mirrors the transfer engine's candidate hygiene: hidden accounts are
    // duplicate-data views (their transactions mirror a visible account), and
    // confirmed transfer halves are inter-account money movement, not bills or
    // income: a monthly savings transfer would otherwise read as a recurring
    // "bill".
    let result = executor
        .query(
            "SELECT
       t.transaction_id,
       t.amount,
       t.date::text AS date,
       t.merchant_name,
       t.name
     FROM transactions t
     JOIN accounts a ON a.account_id = t.account_id
     WHERE t.user_id = $1
       AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
       AND COALESCE(t.pending, FALSE) = FALSE
       AND t.amount <> 0
       AND COALESCE(a.hide, FALSE) = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = t.user_id
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND tp.status = 'confirmed'
           AND (tp.transaction_id_a = t.transaction_id
                OR tp.transaction_id_b = t.transaction_id)
       )
     ORDER BY t.transaction_id",
            &[json!(user_id)],
        )
        .await?;
    Ok(result
        .rows
        .iter()
        .map(|row| RecurringCandidate {
            transaction_id: str_of(row, "transaction_id").to_string(),
            amount: number_of(row.get("amount")),
            date: date_of(row),
            merchant_name: text_of(row, "merchant_name"),
            name: text_of(row, "name"),
        })
        .collect())
}

/// Resolve recurring members straight from transactions rather than from the
/// candidate list: a member added by hand can sit outside candidacy (hidden
/// account, later paired as a transfer) and still marks how far the recurring
/// has collected.
async fn fetch_members(user_id: &str, transaction_ids: &[String], executor: &dyn Executor) -> anyhow::Result<Vec<RecurringCandidate>> {
    let result = executor
        .query(
            "SELECT t.transaction_id, t.amount, t.date::text AS date, t.merchant_name
     FROM transactions t
     WHERE t.user_id = $1
       AND t.transaction_id = ANY($2::text[])
       AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)",
            &[json!(user_id), json!(transaction_ids)],
        )
        .await?;
    Ok(result
        .rows
        .iter()
        .map(|row| RecurringCandidate {
            transaction_id: str_of(row, "transaction_id").to_string(),
            amount: number_of(row.get("amount")),
            date: date_of(row),
            merchant_name: text_of(row, "merchant_name"),
            name: None,
        })
        .collect())
}

fn same_id_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let set_b: HashSet<&str> = b.iter().map(String::as_str).collect();
    a.iter().all(|id| set_b.contains(id.as_str()))
}

/// `recurring.transaction_ids`.
fn transaction_ids_of(row: &Row) -> Vec<String> {
    row.get(TRANSACTION_IDS)
        .and_then(|ids| ids.as_array())
        .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// `${merchant_key}::${is_income}`.
fn reconcile_key(merchant_key: &str, is_income: bool) -> String {
    format!("{merchant_key}::{is_income}")
}

fn row_key(row: &Row) -> String {
    reconcile_key(str_of(row, MERCHANT_KEY), row.get(IS_INCOME) == Some(&Json::Bool(true)))
}

/// What one user's run did.
struct UserRun {
    suggested: i64,
    attached: i64,
}

/// One user's run, inside the transaction the caller opened on `client`.
async fn detect_for_user(client: &Client, user_id: &str) -> anyhow::Result<UserRun> {
    client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))", &[json!(user_id)]).await?;

    // Stale cleanup: a recurring whose members are ALL soft-deleted is a
    // ghost; soft-delete it so it stops rendering and stops claiming nothing.
    let stale_cleanup = client
        .query(
            &format!(
                "UPDATE {RECURRINGS} r
           SET {IS_DELETED} = TRUE, {UPDATED} = CURRENT_TIMESTAMP
           WHERE r.{USER_ID} = $1
             AND (r.{IS_DELETED} IS NULL OR r.{IS_DELETED} = FALSE)
             AND NOT EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.{USER_ID} = $1
                 AND t.transaction_id = ANY(r.{TRANSACTION_IDS})
                 AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
             )"
            ),
            &[json!(user_id)],
        )
        .await?;
    let cleaned = stale_cleanup.row_count.unwrap_or(0);
    if cleaned > 0 {
        logger::info("Cleaned stale recurrings", Some(&ctx! { "userId": user_id, "count": cleaned }));
    }

    let candidates = fetch_candidates(user_id, client).await?;
    let groups = detect_recurring_groups(&candidates, JsDate::now());

    let rows = recurring::TABLE
        .query(filters! { USER_ID => user_id }, SearchFilters { exclude_deleted: Some(false), ..Default::default() }, Some(client))
        .await?;
    let existing: Vec<&Row> = rows.iter().filter(|r| !truthy_opt(r.get(IS_DELETED))).collect();
    let existing_by_key: HashMap<String, &Row> = existing.iter().map(|r| (row_key(r), *r)).collect();
    let deleted_by_key: HashMap<String, &Row> =
        rows.iter().filter(|r| truthy_opt(r.get(IS_DELETED))).map(|r| (row_key(r), r)).collect();

    // Charges already in an active recurring, and those recurrings' keys.
    let active: Vec<&Row> = existing.iter().copied().filter(|r| str_of(r, STATUS) != "dismissed").collect();
    let mut claimed: HashSet<String> = active.iter().flat_map(|r| transaction_ids_of(r)).collect();
    let active_keys: HashSet<String> = active.iter().map(|r| str_of(r, MERCHANT_KEY).to_string()).collect();

    let mut suggested = 0;
    let mut attached = 0;
    for group in &groups {
        let key = reconcile_key(&group.merchant_key, group.is_income);

        let Some(row) = existing_by_key.get(&key) else {
            // The unique key also covers soft-deleted rows: a merchant whose
            // recurring was cascade-deleted revives that row with the new
            // charges and its status, name and default label as they were, so
            // a dismissal still holds and a confirmed recurring carries on.
            // Either way it takes only charges no active recurring holds, as
            // attaching does, and a suggestion still needs enough of them.
            let revives_confirmed = deleted_by_key.get(&key).is_some_and(|row| str_of(row, STATUS) == "confirmed");
            let ids: Vec<String> = group.transaction_ids.iter().filter(|id| !claimed.contains(*id)).cloned().collect();
            if ids.is_empty() || (!revives_confirmed && ids.len() < MIN_OCCURRENCES) {
                continue;
            }
            let inserted = client
                .query(
                    &format!(
                        "INSERT INTO {RECURRINGS}
                 ({RECURRING_ID}, {USER_ID}, {MERCHANT_KEY}, {MERCHANT_NAME}, {CADENCE}, {IS_INCOME}, {STATUS}, {TRANSACTION_IDS})
               VALUES ($1, $2, $3, $4, $5, $6, 'suggested', $7)
               ON CONFLICT ({USER_ID}, {MERCHANT_KEY}, {IS_INCOME}) DO UPDATE SET
                 {CADENCE} = EXCLUDED.{CADENCE},
                 {TRANSACTION_IDS} = EXCLUDED.{TRANSACTION_IDS},
                 {IS_DELETED} = FALSE,
                 {UPDATED} = CURRENT_TIMESTAMP
               WHERE {RECURRINGS}.{IS_DELETED} = TRUE
               RETURNING {RECURRING_ID}, {STATUS}"
                    ),
                    &[
                        json!(uuid::Uuid::new_v4().to_string()),
                        json!(user_id),
                        json!(group.merchant_key),
                        json!(group.merchant_name),
                        json!(group.cadence),
                        json!(group.is_income),
                        json!(ids),
                    ],
                )
                .await?;
            if let Some(revived) = inserted.rows.first() {
                let status = str_of(revived, STATUS);
                if status != "dismissed" {
                    claimed.extend(ids.iter().cloned());
                }
                if status == "suggested" {
                    suggested += 1;
                }
                if status == "confirmed" {
                    label_confirmed_recurring(client, user_id, str_of(revived, RECURRING_ID), Some(ids.as_slice())).await?;
                    attached += ids.len() as i64;
                }
            }
            continue;
        };

        let status = str_of(row, STATUS);
        if status == "dismissed" {
            continue;
        }

        if status == "suggested" {
            // Refresh membership when the detected set changed (new charges
            // arrived, or deleted ones fell out of candidacy). No UPDATE when
            // identical: that avoids `updated` churn that would spam delta
            // syncs with no-op bumps. The name is left alone: the user may
            // have renamed the suggestion. A charge another active recurring
            // holds stays there.
            let held = transaction_ids_of(row);
            let ids: Vec<String> =
                group.transaction_ids.iter().filter(|id| !claimed.contains(*id) || held.contains(id)).cloned().collect();
            if !same_id_set(&held, &ids) {
                client
                    .query(
                        &format!(
                            "UPDATE {RECURRINGS}
                 SET {TRANSACTION_IDS} = $2, {CADENCE} = $3, {UPDATED} = CURRENT_TIMESTAMP
                 WHERE {RECURRING_ID} = $1"
                        ),
                        &[json!(str_of(row, RECURRING_ID)), json!(ids), json!(group.cadence)],
                    )
                    .await?;
            }
            claimed.extend(ids);
            continue;
        }
    }

    // Confirmed: attach each new charge. Runs per row rather than per group,
    // so a merchant whose history no longer qualifies (one late charge, a
    // price change, a stray purchase), or a manual recurring that never did,
    // keeps collecting. A row revived above isn't in `existing`; its charges
    // are already in `claimed`, and it collects from the next run on.
    let confirmed: Vec<&Row> = existing.iter().copied().filter(|r| str_of(r, STATUS) == "confirmed").collect();
    if !confirmed.is_empty() {
        let all_member_ids: Vec<String> = confirmed.iter().flat_map(|r| transaction_ids_of(r)).collect();
        let members = fetch_members(user_id, &all_member_ids, client).await?;
        let member_by_id: HashMap<&str, &RecurringCandidate> = members.iter().map(|m| (m.transaction_id.as_str(), m)).collect();
        let group_by_key: HashMap<String, &DetectedRecurringGroup> =
            groups.iter().map(|g| (reconcile_key(&g.merchant_key, g.is_income), g)).collect();
        for row in confirmed {
            let is_income = row.get(IS_INCOME) == Some(&Json::Bool(true));
            let snapshot = ConfirmedRecurringSnapshot {
                merchant_key: str_of(row, MERCHANT_KEY).to_string(),
                is_income,
                cadence: str_of(row, CADENCE).to_string(),
                members: transaction_ids_of(row).iter().filter_map(|id| member_by_id.get(id.as_str()).map(|m| (*m).clone())).collect(),
            };
            let group = group_by_key.get(&row_key(row)).map(|g| g.transaction_ids.as_slice());
            let fresh = select_confirmed_attachments(&snapshot, &candidates, &claimed, group, &active_keys);
            if fresh.is_empty() {
                continue;
            }
            let recurring_id = str_of(row, RECURRING_ID);
            client
                .query(
                    &format!(
                        "UPDATE {RECURRINGS}
               SET {TRANSACTION_IDS} = {TRANSACTION_IDS} || $2::text[],
                   {UPDATED} = CURRENT_TIMESTAMP
               WHERE {RECURRING_ID} = $1"
                    ),
                    &[json!(recurring_id), json!(fresh)],
                )
                .await?;
            // New charges take the recurring's default label.
            label_confirmed_recurring(client, user_id, recurring_id, Some(fresh.as_slice())).await?;
            attached += fresh.len() as i64;
            claimed.extend(fresh);
        }
    }

    client.query("COMMIT", &[]).await?;
    if suggested > 0 || attached > 0 {
        logger::info(
            "Updated recurrings for user",
            Some(&ctx! {
                "userId": user_id,
                "suggested": suggested,
                "attached": attached,
                "groupsDetected": groups.len(),
            }),
        );
    }
    Ok(UserRun { suggested, attached })
}

/// Background job that scans settled transactions and suggests recurrings.
///
/// Per user (under an advisory lock serializing against manual
/// `create_recurring` calls and concurrent detection runs):
///   1. Cascade-soft-delete recurrings whose members are all soft-deleted
///      (mirrors the transfer engine's stale-pair cleanup).
///   2. Group candidates with `detect_recurring_groups`.
///   3. For each group, reconcile against the existing row for
///      (merchant_key, is_income):
///        - none → INSERT a suggestion, or revive the key's soft-deleted row
///          keeping its status (a confirmed one takes only unclaimed charges)
///        - dismissed → skip (the denylist: the user said "no" to this
///          merchant group, not "these transactions can never recur")
///        - suggested → refresh transaction_ids when the set changed
///        - confirmed → left to step 4
///   4. For each confirmed recurring, append the charges
///      `select_confirmed_attachments` picks: its merchant's detected group
///      when that holds one of its members, plus new charges due on its
///      schedule. This is how a confirmed recurring collects each new charge.
pub async fn run_recurring_detection() -> anyhow::Result<()> {
    logger::info("Recurring-detection job started", None);

    let mut total_users = 0i64;
    let mut total_suggested = 0i64;
    let mut total_attached = 0i64;

    match user::TABLE.query(Vec::new(), SearchFilters::default(), None).await {
        Ok(users) => {
            for user in &users {
                let user_id = str_of(user, USER_ID);
                let client = match pool().connect().await {
                    Ok(client) => client,
                    Err(error) => {
                        logger::error("Recurring detection failed for user", Some(&ctx! { "userId": user_id }), Some(&error));
                        continue;
                    }
                };
                let run = async {
                    client.query("BEGIN", &[]).await?;
                    detect_for_user(&client, user_id).await
                }
                .await;
                match run {
                    Ok(run) => {
                        total_users += 1;
                        total_suggested += run.suggested;
                        total_attached += run.attached;
                    }
                    Err(error) => {
                        let _ = client.query("ROLLBACK", &[]).await;
                        logger::error("Recurring detection failed for user", Some(&ctx! { "userId": user_id }), Some(&error));
                    }
                }
            }
        }
        Err(error) => {
            logger::error("Recurring-detection job failed to fetch users", None, Some(&error));
        }
    }

    logger::info(
        "Recurring-detection job completed",
        Some(&ctx! {
            "usersProcessed": total_users,
            "recurringsSuggested": total_suggested,
            "chargesAttached": total_attached,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> JsDate {
        JsDate::parse("2026-10-15T12:00:00Z")
    }

    fn txn(id: &str, date: &str, amount: f64, merchant: Option<&str>, name: &str) -> RecurringCandidate {
        RecurringCandidate {
            transaction_id: id.to_string(),
            amount,
            date: date.to_string(),
            merchant_name: merchant.map(str::to_string),
            name: Some(name.to_string()),
        }
    }

    /// A charge named `merchant` both ways.
    fn charge(id: &str, date: &str, amount: f64, merchant: &str) -> RecurringCandidate {
        txn(id, date, amount, Some(merchant), merchant)
    }

    /// Monthly charges on the 15th, `count` of them ending Sep 2026, newest first.
    fn monthly(merchant: &str, count: usize, amount: f64) -> Vec<RecurringCandidate> {
        (0..count)
            .map(|i| {
                let month = 9 - i as i64;
                let (year, month) = if month >= 1 { (2026, month) } else { (2025, month + 12) };
                charge(&format!("{merchant}-{i}"), &format!("{year}-{month:02}-15"), amount, merchant)
            })
            .collect()
    }

    fn ids(groups: &[DetectedRecurringGroup]) -> Vec<Vec<String>> {
        groups.iter().map(|g| g.transaction_ids.clone()).collect()
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // `detect-recurrings.test.ts`, "normalizeMerchantName".
    #[test]
    fn normalizes_merchant_names() {
        assert_eq!(normalize_merchant_name("NETFLIX.COM"), "netflix");
        assert_eq!(normalize_merchant_name("Netflix 8665795717"), "netflix");
        assert_eq!(normalize_merchant_name("7-Eleven"), "7 eleven");
        assert_eq!(normalize_merchant_name("Comcast"), "comcast");
        assert_eq!(normalize_merchant_name("Hulu LLC"), "hulu llc");
        assert_eq!(normalize_merchant_name("Manual DB-Bkrg 07/03"), "manual db bkrg");
        assert_eq!(normalize_merchant_name("Manual DB-Bkrg 10/03"), "manual db bkrg");
        assert_eq!(normalize_merchant_name("Utility 03/15/26"), "utility");
        assert_eq!(normalize_merchant_name("24/7 Fitness"), "24 7 fitness");
        assert_eq!(normalize_merchant_name("Shop 13/40"), "shop 13 40");
        assert_eq!(normalize_merchant_name("Shop 1/2"), "shop 1 2");
    }

    #[test]
    fn normalizes_the_way_javascript_patterns_do() {
        // Only ASCII digits make a date or a long digit run.
        assert_eq!(normalize_merchant_name("Café ٠١٢٣٤٥"), "café ٠١٢٣٤٥");
        assert_eq!(normalize_merchant_name("Shop 123456 net"), "shop");
        // A date glued to a letter has no word boundary before it.
        assert_eq!(normalize_merchant_name("x07/03"), "x07 03");
        // The BOM and the no-break space are white space; the next-line control is not.
        assert_eq!(normalize_merchant_name("a\u{FEFF}b\u{A0}c\u{85}d"), "a b c d");
        assert_eq!(normalize_merchant_name("COM"), "com");
        assert_eq!(normalize_merchant_name("..."), "");
        // Lowercasing is Unicode's: a final sigma, and a dotted capital I's combining dot as punctuation.
        assert_eq!(normalize_merchant_name("ΣΑΣ"), "σας");
        assert_eq!(normalize_merchant_name("İstanbul"), "i stanbul");
        // A partial year leaves the month and day as the date; an underscore is a word character.
        assert_eq!(normalize_merchant_name("07/03/202 x"), "202 x");
        assert_eq!(normalize_merchant_name("12/31/2026"), "");
        assert_eq!(normalize_merchant_name("a_07/03"), "a 07 03");
    }

    // `detect-recurrings.test.ts`, "detectRecurringGroups".
    #[test]
    fn detects_a_monthly_bill() {
        let groups = detect_recurring_groups(&monthly("Netflix", 4, 15.99), now());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].merchant_key, "netflix");
        assert_eq!(groups[0].merchant_name, "Netflix");
        assert_eq!(groups[0].cadence, "monthly");
        assert!(!groups[0].is_income);
        assert_eq!(groups[0].transaction_ids.len(), 4);
    }

    #[test]
    fn requires_at_least_three_occurrences() {
        assert!(detect_recurring_groups(&monthly("Netflix", 2, 15.99), now()).is_empty());
    }

    #[test]
    fn detects_income_separately_from_expenses() {
        let mut candidates: Vec<RecurringCandidate> = monthly("Employer", 4, -3000.0)
            .into_iter()
            .map(|t| RecurringCandidate { merchant_name: Some("Employer Inc".into()), name: Some("Employer Inc".into()), ..t })
            .collect();
        candidates.extend(monthly("Netflix", 4, 15.99));
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(groups.len(), 2);
        assert_eq!(groups.iter().find(|g| g.is_income).map(|g| g.merchant_key.as_str()), Some("employer inc"));
        assert_eq!(groups.iter().find(|g| !g.is_income).map(|g| g.merchant_key.as_str()), Some("netflix"));
    }

    #[test]
    fn groups_noisy_merchant_name_variants() {
        let candidates: Vec<RecurringCandidate> = monthly("Netflix", 4, 15.99)
            .into_iter()
            .enumerate()
            .map(|(i, t)| RecurringCandidate {
                merchant_name: Some(if i == 3 { "Netflix 8665795717" } else { "NETFLIX.COM" }.into()),
                ..t
            })
            .collect();
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].merchant_name, "NETFLIX.COM");
    }

    #[test]
    fn rejects_irregular_intervals() {
        let candidates = [
            charge("a", "2026-09-15", 15.99, "Netflix"),
            charge("b", "2026-09-20", 15.99, "Netflix"),
            charge("c", "2026-10-15", 15.99, "Netflix"),
        ];
        assert!(detect_recurring_groups(&candidates, now()).is_empty());
    }

    fn with_amounts(mut candidates: Vec<RecurringCandidate>, amounts: &[f64]) -> Vec<RecurringCandidate> {
        for (t, amount) in candidates.iter_mut().zip(amounts) {
            t.amount = *amount;
        }
        candidates
    }

    #[test]
    fn rejects_amounts_outside_a_quarter_of_the_median_and_tolerates_those_inside() {
        assert!(detect_recurring_groups(&with_amounts(monthly("Utility", 4, 1.0), &[50.0, 70.0, 36.0, 60.0]), now()).is_empty());
        assert_eq!(detect_recurring_groups(&with_amounts(monthly("Utility", 4, 1.0), &[50.0, 55.0, 48.0, 60.0]), now()).len(), 1);
    }

    #[test]
    fn leaves_a_one_off_charge_at_another_price_out_of_the_bill() {
        let candidates = with_amounts(monthly("Utility", 5, 15.99), &[15.99, 15.99, 15.99, 15.99, 100.0]);
        assert_eq!(
            ids(&detect_recurring_groups(&candidates, now())),
            vec![strings(&["Utility-3", "Utility-2", "Utility-1", "Utility-0"])]
        );
    }

    #[test]
    fn an_old_gap_or_mislabelled_charge_does_not_disqualify_the_recent_run() {
        let mut candidates: Vec<RecurringCandidate> = ["2025-03-16", "2025-04-14", "2025-05-16", "2025-06-16"]
            .iter()
            .enumerate()
            .map(|(i, date)| txn(&format!("old-{i}"), date, 2.99, Some("YouTube Premium"), "Netflix"))
            .collect();
        candidates.extend(
            ["2025-07-22", "2025-08-22", "2025-09-22", "2025-10-22", "2025-11-22"]
                .iter()
                .enumerate()
                .map(|(i, date)| txn(&format!("old-premium-{i}"), date, 22.99, Some("YouTube Premium"), "Netflix")),
        );
        candidates.extend(monthly("YouTube Premium", 4, 22.99));
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(groups.iter().map(|g| g.cadence).collect::<Vec<_>>(), vec!["monthly"]);
        assert_eq!(
            ids(&groups),
            vec![strings(&["YouTube Premium-3", "YouTube Premium-2", "YouTube Premium-1", "YouTube Premium-0"])]
        );
    }

    #[test]
    fn a_run_that_leaves_earlier_charges_out_needs_four_occurrences() {
        let irregular: Vec<RecurringCandidate> = ["2026-01-03", "2026-01-20", "2026-03-02"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("early-{i}"), date, 20.0, "Corner Shop"))
            .collect();
        let run: Vec<RecurringCandidate> = ["2026-07-15", "2026-08-15", "2026-09-15"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("m-{i}"), date, 20.0, "Corner Shop"))
            .collect();
        assert!(detect_recurring_groups(&[irregular.clone(), run.clone()].concat(), now()).is_empty());
        assert_eq!(detect_recurring_groups(&run, now()).len(), 1);
        let fourth = charge("m-3", "2026-06-15", 20.0, "Corner Shop");
        let groups = detect_recurring_groups(&[irregular, vec![fourth], run].concat(), now());
        assert_eq!(ids(&groups), vec![strings(&["m-3", "m-0", "m-1", "m-2"])]);
    }

    #[test]
    fn a_price_rise_does_not_disqualify_the_bill() {
        let candidates: Vec<RecurringCandidate> = ["03", "04", "05", "06", "07", "08", "09"]
            .iter()
            .enumerate()
            .map(|(i, month)| charge(&format!("s-{month}"), &format!("2026-{month}-15"), if i < 4 { 10.0 } else { 15.0 }, "Streaming"))
            .collect();
        assert_eq!(
            ids(&detect_recurring_groups(&candidates, now())),
            vec![strings(&["s-04", "s-05", "s-06", "s-07", "s-08", "s-09"])]
        );
    }

    #[test]
    fn a_fee_keeps_losing_to_the_rent_when_the_rents_run_is_shorter() {
        let months = ["01", "02", "03", "04", "05", "06", "07", "08", "09"];
        let rent: Vec<RecurringCandidate> = months
            .iter()
            .map(|m| charge(&format!("rent-{m}"), &format!("2026-{m}-{}", if *m == "03" { "10" } else { "02" }), 3900.0, "Housing"))
            .collect();
        let fee: Vec<RecurringCandidate> =
            months.iter().map(|m| charge(&format!("fee-{m}"), &format!("2026-{m}-02"), 2.49, "Housing")).collect();
        assert_eq!(
            ids(&detect_recurring_groups(&[fee, rent].concat(), now())),
            vec![strings(&["rent-04", "rent-05", "rent-06", "rent-07", "rent-08", "rent-09"])]
        );
    }

    #[test]
    fn a_second_plan_at_twice_the_price_is_its_own_stream() {
        let months = ["06", "07", "08", "09"];
        let basic: Vec<RecurringCandidate> =
            months.iter().map(|m| charge(&format!("basic-{m}"), &format!("2026-{m}-01"), 10.0, "Phone")).collect();
        let family: Vec<RecurringCandidate> =
            months.iter().map(|m| charge(&format!("family-{m}"), &format!("2026-{m}-15"), 20.0, "Phone")).collect();
        assert_eq!(
            ids(&detect_recurring_groups(&[basic, family].concat(), now())),
            vec![strings(&["family-06", "family-07", "family-08", "family-09"])]
        );
    }

    #[test]
    fn earlier_charges_at_other_prices_also_call_for_a_fourth_occurrence() {
        let irregular: Vec<RecurringCandidate> = [("2026-01-03", 80.0), ("2026-02-20", 95.0), ("2026-04-09", 8.0), ("2026-05-01", 9.0)]
            .iter()
            .enumerate()
            .map(|(i, (date, amount))| charge(&format!("odd-{i}"), date, *amount, "Corner Shop"))
            .collect();
        let run: Vec<RecurringCandidate> = ["2026-07-15", "2026-08-15", "2026-09-15"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("m-{i}"), date, 25.0, "Corner Shop"))
            .collect();
        assert!(detect_recurring_groups(&[irregular, run].concat(), now()).is_empty());
    }

    #[test]
    fn a_fee_billed_beside_the_rent_never_displaces_it() {
        let rent = monthly("Housing", 4, 3900.0);
        let fee: Vec<RecurringCandidate> = monthly("Housing", 4, 2.49)
            .into_iter()
            .map(|t| RecurringCandidate { transaction_id: format!("fee-{}", t.transaction_id), ..t })
            .collect();
        assert_eq!(
            ids(&detect_recurring_groups(&[fee, rent].concat(), now())),
            vec![strings(&["Housing-3", "Housing-2", "Housing-1", "Housing-0"])]
        );
    }

    #[test]
    fn a_bonus_paid_on_payday_stays_out_of_the_paycheck_run() {
        let dates = ["2026-10-09", "2026-09-25", "2026-09-11", "2026-08-28"];
        let mut candidates: Vec<RecurringCandidate> =
            dates.iter().enumerate().map(|(i, date)| charge(&format!("pay-{i}"), date, -2500.0, "Employer Payroll")).collect();
        candidates.push(charge("bonus", dates[1], -11000.0, "Employer Payroll"));
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(groups.iter().map(|g| (g.cadence, g.is_income)).collect::<Vec<_>>(), vec![("biweekly", true)]);
        assert_eq!(ids(&groups), vec![strings(&["pay-3", "pay-2", "pay-1", "pay-0"])]);
    }

    #[test]
    fn monthly_charges_keyed_with_their_posting_dates_group_as_one_merchant() {
        let candidates: Vec<RecurringCandidate> = monthly("x", 4, 15.99)
            .into_iter()
            .map(|t| {
                let name = format!("Manual DB-Bkrg {}/{}", &t.date[5..7], &t.date[8..10]);
                RecurringCandidate { merchant_name: None, name: Some(name), ..t }
            })
            .collect();
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(
            groups.iter().map(|g| (g.merchant_key.as_str(), g.cadence, g.transaction_ids.len())).collect::<Vec<_>>(),
            vec![("manual db bkrg", "monthly", 4)]
        );
    }

    #[test]
    fn excludes_lapsed_groups() {
        let candidates: Vec<RecurringCandidate> = ["2026-04-15", "2026-03-15", "2026-02-15", "2026-01-15"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("old-{i}"), date, 15.99, "Netflix"))
            .collect();
        assert!(detect_recurring_groups(&candidates, now()).is_empty());
    }

    #[test]
    fn detects_weekly_cadence() {
        let candidates: Vec<RecurringCandidate> = ["2026-10-15", "2026-10-08", "2026-10-01", "2026-09-24"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("w-{i}"), date, 15.99, "Gym"))
            .collect();
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(groups.iter().map(|g| g.cadence).collect::<Vec<_>>(), vec!["weekly"]);
    }

    #[test]
    fn skips_zero_amount_and_dateless_candidates_and_orders_oldest_first() {
        let mut candidates = monthly("Netflix", 3, 15.99);
        candidates.push(charge("z", "2026-09-15", 0.0, "Netflix"));
        candidates.push(charge("d", "not-a-date", 15.99, "Netflix"));
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(ids(&groups), vec![strings(&["Netflix-2", "Netflix-1", "Netflix-0"])]);
    }

    #[test]
    fn today_is_the_utc_day_of_now() {
        // Weekly, last charge 2026-10-01: 14 days before the 15th still recurs, 15 days does not.
        let candidates: Vec<RecurringCandidate> = ["2026-10-01", "2026-09-24", "2026-09-17"]
            .iter()
            .enumerate()
            .map(|(i, date)| charge(&format!("w-{i}"), date, 9.0, "Gym"))
            .collect();
        let cadences = |groups: Vec<DetectedRecurringGroup>| groups.iter().map(|g| g.cadence).collect::<Vec<_>>();
        assert_eq!(cadences(detect_recurring_groups(&candidates, JsDate::parse("2026-10-15T23:59:00Z"))), vec!["weekly"]);
        assert_eq!(cadences(detect_recurring_groups(&candidates, JsDate::parse("2026-10-16T00:00:00Z"))), Vec::<&str>::new());
    }

    // `detect-recurrings.test.ts`, "selectConfirmedAttachments".
    fn confirmed(members: Vec<RecurringCandidate>, merchant_key: &str, is_income: bool) -> ConfirmedRecurringSnapshot {
        ConfirmedRecurringSnapshot { merchant_key: merchant_key.into(), is_income, cadence: "monthly".into(), members }
    }

    fn netflix(members: Vec<RecurringCandidate>) -> ConfirmedRecurringSnapshot {
        confirmed(members, "netflix", false)
    }

    fn nf(id: &str, date: &str) -> RecurringCandidate {
        charge(id, date, 15.99, "Netflix")
    }

    fn history() -> Vec<RecurringCandidate> {
        vec![nf("jul", "2026-07-15"), nf("aug", "2026-08-15"), nf("sep", "2026-09-15")]
    }

    fn claimed_by(recurrings: &[&ConfirmedRecurringSnapshot]) -> HashSet<String> {
        recurrings.iter().flat_map(|r| r.members.iter().map(|m| m.transaction_id.clone())).collect()
    }

    fn select(recurring: &ConfirmedRecurringSnapshot, candidates: &[RecurringCandidate]) -> Vec<String> {
        select_confirmed_attachments(recurring, candidates, &claimed_by(&[recurring]), None, &HashSet::new())
    }

    fn select_with_group(recurring: &ConfirmedRecurringSnapshot, candidates: &[RecurringCandidate], group: &[&str]) -> Vec<String> {
        select_confirmed_attachments(recurring, candidates, &claimed_by(&[recurring]), Some(&strings(group)), &HashSet::new())
    }

    /// Feeds charges in one per run, as the hourly job sees them settle.
    fn run_incrementally(recurring: &ConfirmedRecurringSnapshot, charges: &[RecurringCandidate]) -> Vec<String> {
        let mut members = recurring.members.clone();
        let mut pool: Vec<RecurringCandidate> = Vec::new();
        for c in charges {
            pool.push(c.clone());
            let current = ConfirmedRecurringSnapshot { members: members.clone(), ..recurring.clone() };
            let picked = select(&current, &pool);
            members.extend(pool.iter().filter(|p| picked.contains(&p.transaction_id)).cloned());
        }
        members
            .iter()
            .map(|m| m.transaction_id.clone())
            .filter(|id| !recurring.members.iter().any(|m| m.transaction_id == *id))
            .collect()
    }

    #[test]
    fn attaches_the_next_on_schedule_charge() {
        let recurring = netflix(history());
        assert_eq!(select(&recurring, &[history(), vec![nf("oct", "2026-10-15")]].concat()), strings(&["oct"]));
    }

    #[test]
    fn attaches_a_late_charge_and_the_on_time_one_after_it() {
        let recurring = netflix(history());
        assert_eq!(select(&recurring, &[nf("oct-late", "2026-10-27"), nf("nov", "2026-11-15")]), strings(&["oct-late", "nov"]));
    }

    #[test]
    fn attaches_the_charge_after_a_skipped_cycle() {
        assert_eq!(select(&netflix(history()), &[nf("nov", "2026-11-15")]), strings(&["nov"]));
    }

    #[test]
    fn attaches_a_price_change_once_the_new_price_repeats() {
        let recurring = netflix(history());
        let repriced = [charge("oct", "2026-10-15", 22.99, "Netflix"), charge("nov", "2026-11-15", 22.99, "Netflix")];
        assert_eq!(select(&recurring, &repriced[..1]), Vec::<String>::new());
        assert_eq!(select(&recurring, &repriced), strings(&["oct", "nov"]));
        let charges = [repriced.to_vec(), vec![charge("dec", "2026-12-15", 22.99, "Netflix")]].concat();
        assert_eq!(run_incrementally(&recurring, &charges), strings(&["oct", "nov", "dec"]));
    }

    #[test]
    fn leaves_late_or_too_large_repricings_for_a_manual_add() {
        let recurring = netflix(history());
        let late = [charge("oct-late", "2026-10-27", 22.99, "Netflix"), charge("nov-late", "2026-11-27", 22.99, "Netflix")];
        assert_eq!(select(&recurring, &late), Vec::<String>::new());
        let jump = [charge("oct", "2026-10-15", 39.99, "Netflix"), charge("nov", "2026-11-15", 39.99, "Netflix")];
        assert_eq!(select(&recurring, &jump), Vec::<String>::new());
    }

    #[test]
    fn skips_one_off_purchases_at_the_same_merchant() {
        let icloud = |id: &str, date: &str, amount: f64| charge(id, date, amount, "APPLE.COM");
        let recurring = confirmed(vec![icloud("aug", "2026-08-15", 2.99), icloud("sep", "2026-09-15", 2.99)], "apple", false);
        let candidates = [
            icloud("app", "2026-10-02", 49.99),
            icloud("movie", "2026-10-14", 5.49),
            icloud("oct", "2026-10-15", 2.99),
            icloud("app-again", "2026-11-03", 49.99),
        ];
        assert_eq!(select(&recurring, &candidates), strings(&["oct"]));
    }

    fn prime(id: &str, date: &str, amount: f64) -> RecurringCandidate {
        charge(id, date, amount, "Amazon")
    }

    #[test]
    fn a_same_priced_purchase_mid_cycle_neither_joins_nor_blocks_the_next_charge() {
        let recurring = confirmed(vec![prime("sep", "2026-09-01", 14.99)], "amazon", false);
        let candidates = [prime("order", "2026-09-20", 13.0), prime("oct", "2026-10-01", 14.99)];
        assert_eq!(run_incrementally(&recurring, &candidates), strings(&["oct"]));
    }

    #[test]
    fn off_schedule_purchases_stay_out_and_the_closest_to_the_due_date_wins() {
        let recurring = confirmed(vec![prime("aug", "2026-08-01", 14.99), prime("sep", "2026-09-01", 14.99)], "amazon", false);
        let candidates = [
            prime("book", "2026-09-12", 12.5),
            prime("charger", "2026-09-24", 17.0),
            prime("oct", "2026-10-01", 14.99),
            prime("cable", "2026-10-18", 15.0),
            prime("nov", "2026-11-01", 14.99),
        ];
        assert_eq!(select(&recurring, &candidates), strings(&["oct", "nov"]));
        assert_eq!(select(&recurring, &[prime("order", "2026-09-28", 14.0), prime("oct", "2026-10-01", 14.99)]), strings(&["oct"]));
        let drift = [
            prime("a", "2026-09-10", 18.0),
            prime("b", "2026-09-17", 22.0),
            prime("c", "2026-09-24", 27.0),
            prime("oct", "2026-10-01", 14.99),
        ];
        assert_eq!(select(&recurring, &drift), strings(&["oct"]));
    }

    #[test]
    fn a_qualifying_group_brings_in_history_and_late_synced_charges() {
        let recurring = netflix(vec![nf("oct", "2026-10-15")]);
        let candidates = [history(), vec![nf("oct", "2026-10-15")]].concat();
        let group = ["jul", "aug", "sep", "oct"];
        assert_eq!(select_with_group(&recurring, &candidates, &group), strings(&["jul", "aug", "sep"]));

        let h = history();
        let recurring = netflix(vec![h[0].clone(), h[2].clone(), nf("oct", "2026-10-15")]);
        assert_eq!(select_with_group(&recurring, &candidates, &group), strings(&["aug"]));

        let claimed: HashSet<String> = ["oct", "aug"].iter().map(|s| s.to_string()).collect();
        let recurring = netflix(vec![nf("oct", "2026-10-15")]);
        assert_eq!(
            select_confirmed_attachments(&recurring, &candidates, &claimed, Some(&strings(&group)), &HashSet::new()),
            strings(&["jul", "sep"])
        );
    }

    #[test]
    fn a_group_billed_at_another_price_does_not_join() {
        let members = vec![
            charge("jul", "2026-07-15", 2.99, "Netflix"),
            charge("aug", "2026-08-15", 2.99, "Netflix"),
            charge("sep", "2026-09-15", 2.99, "Netflix"),
        ];
        let recurring = netflix(members.clone());
        let other: Vec<RecurringCandidate> =
            ["06", "07", "08", "09"].iter().map(|m| charge(&format!("plus-{m}"), &format!("2026-{m}-20"), 10.99, "Netflix")).collect();
        let candidates = [members, other].concat();
        let groups = detect_recurring_groups(&candidates, now());
        assert_eq!(ids(&groups), vec![strings(&["plus-06", "plus-07", "plus-08", "plus-09"])]);
        assert_eq!(
            select_confirmed_attachments(
                &recurring,
                &candidates,
                &claimed_by(&[&recurring]),
                Some(&groups[0].transaction_ids),
                &HashSet::new()
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_single_transaction_manual_recurring_collects_later_charges() {
        let gym = |id: &str, date: &str| charge(id, date, 25.0, "Gym");
        let recurring = confirmed(vec![gym("w0", "2026-09-01")], "gym", false);
        let candidates = [gym("w1", "2026-09-08"), gym("w2", "2026-09-15"), gym("w3", "2026-09-22")];
        assert_eq!(select(&recurring, &candidates), strings(&["w1", "w2", "w3"]));
    }

    #[test]
    fn only_takes_unclaimed_same_merchant_same_direction_charges_after_the_latest_member() {
        let recurring = netflix(history());
        let other = confirmed(vec![nf("elsewhere", "2026-10-20")], "something else", false);
        let candidates = [
            history(),
            vec![
                nf("before", "2026-09-01"),
                nf("same-day", "2026-09-15"),
                charge("refund", "2026-10-01", -15.99, "Netflix"),
                charge("hulu", "2026-10-15", 15.99, "Hulu"),
                nf("elsewhere", "2026-10-20"),
                charge("noisy", "2026-10-15", 15.99, "NETFLIX.COM"),
            ],
        ]
        .concat();
        assert_eq!(
            select_confirmed_attachments(&recurring, &candidates, &claimed_by(&[&recurring, &other]), None, &HashSet::new()),
            strings(&["noisy"])
        );
    }

    fn bakery(id: &str, date: &str, merchant: Option<&str>, amount: f64) -> RecurringCandidate {
        txn(id, date, amount, merchant, &format!("POS PURCHASE 0412 CORNER BAKERY ANYTOWN {}", date[5..].replace('-', "/")))
    }

    fn weekly_bakery() -> ConfirmedRecurringSnapshot {
        ConfirmedRecurringSnapshot {
            merchant_key: "corner bakery".into(),
            is_income: false,
            cadence: "weekly".into(),
            members: vec![
                bakery("w1", "2026-09-21", Some("Corner Bakery"), 12.0),
                bakery("w2", "2026-09-28", Some("Corner Bakery"), 12.0),
                bakery("w3", "2026-10-05", Some("Corner Bakery"), 12.0),
            ],
        }
    }

    #[test]
    fn a_charge_enrichment_renamed_joins_by_its_description() {
        let recurring = weekly_bakery();
        let renamed = bakery("w4", "2026-10-12", Some("Bakery Holdings Inc."), 12.0);
        assert_eq!(select(&recurring, &[recurring.members.clone(), vec![renamed.clone()]].concat()), strings(&["w4"]));
        let unnamed = bakery("w4", "2026-10-12", None, 12.0);
        assert_eq!(select(&recurring, &[unnamed]), strings(&["w4"]));
        let off_schedule = bakery("mid", "2026-10-08", Some("Bakery Holdings Inc."), 12.0);
        let other_bill = bakery("big", "2026-10-12", Some("Bakery Holdings Inc."), 80.0);
        assert_eq!(select(&recurring, &[off_schedule, other_bill]), Vec::<String>::new());
        let active: HashSet<String> = ["corner bakery", "bakery holdings inc"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            select_confirmed_attachments(&recurring, &[renamed], &claimed_by(&[&recurring]), None, &active),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_description_must_hold_the_whole_key_word_for_word() {
        let recurring = weekly_bakery();
        let described = |name: &str| txn(name, "2026-10-12", 12.0, Some("Bakery Holdings Inc."), name);
        assert_eq!(
            select(
                &recurring,
                &[
                    described("POS PURCHASE 0412 CORNER BAKERYSHOP ANYTOWN"),
                    described("POS THECORNER BAKERY ANYTOWN"),
                    described("POS CORNER STREET BAKERY ANYTOWN"),
                ]
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn descriptions_do_not_count_for_a_descriptor_key_or_a_one_word_key() {
        let descriptor = "APPLE.COM/BILL 866-712-7753 CA";
        let billed = |id: &str, date: &str, merchant: Option<&str>| txn(id, date, 9.99, merchant, descriptor);
        let recurring = ConfirmedRecurringSnapshot {
            merchant_key: normalize_merchant_name(descriptor),
            is_income: false,
            cadence: "monthly".into(),
            members: vec![billed("a1", "2026-07-15", None), billed("a2", "2026-08-15", None), billed("a3", "2026-09-15", None)],
        };
        assert_eq!(select(&recurring, &[billed("music", "2026-10-15", Some("Apple Music"))]), Vec::<String>::new());
        let renamed = txn("oct", "2026-10-15", 15.99, Some("Streaming Co"), "RECURRING NETFLIX 0412");
        assert_eq!(select(&netflix(history()), &[renamed]), Vec::<String>::new());
    }

    #[test]
    fn matches_income_by_direction() {
        let pay = |id: &str, date: &str, amount: f64| charge(id, date, amount, "Employer Inc");
        let recurring = confirmed(vec![pay("sep", "2026-09-30", -3000.0)], "employer inc", true);
        assert_eq!(select(&recurring, &[pay("expense", "2026-10-15", 3000.0), pay("oct", "2026-10-31", -3000.0)]), strings(&["oct"]));
    }

    #[test]
    fn attaches_nothing_without_a_live_member_to_measure_from() {
        assert_eq!(
            select_confirmed_attachments(&netflix(Vec::new()), &[nf("oct", "2026-10-15")], &HashSet::new(), None, &HashSet::new()),
            Vec::<String>::new()
        );
    }

    #[test]
    fn an_unknown_stored_cadence_stops_collecting_once_measuring_fails() {
        // Two members whose interval matches no cadence: the stored cadence is the fallback, and an unknown one ends the walk.
        let mut recurring = netflix(vec![nf("a", "2026-08-01"), nf("b", "2026-08-25")]);
        recurring.cadence = "daily".into();
        assert_eq!(select(&recurring, &[nf("c", "2026-09-25")]), Vec::<String>::new());
        recurring.cadence = "monthly".into();
        assert_eq!(select(&recurring, &[nf("c", "2026-09-25")]), strings(&["c"]));
    }

    #[test]
    fn days_are_counted_and_added_in_local_time() {
        assert_eq!(add_days("2026-01-31", 30.44), "2026-03-02");
        assert_eq!(add_days("2026-12-25", 7.0), "2027-01-01");
        assert_eq!(days_between("2026-03-01", "2026-04-01"), 31.0);
        assert!(!is_valid_date("not-a-date"));
    }

    #[test]
    fn column_values_read_as_javascript_number_does() {
        assert_eq!(number_of(Some(&json!(3))), 3.0);
        assert_eq!(number_of(Some(&Json::Null)), 0.0);
        assert_eq!(number_of(Some(&json!("4.5"))), 4.5);
        assert!(number_of(None).is_nan());
    }
}
