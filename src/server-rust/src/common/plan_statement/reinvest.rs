//! `src/common/plan-statement/reinvest.ts`.
//!
//! The JSON objects, with the TypeScript's keys:
//!
//! - `Distribution`: `{ ex_date, cash_amount, close }`: the ex-date
//!   (`YYYY-MM-DD`), the cash paid per share, and the fund's raw close on the
//!   ex-date, which the payout is reinvested at.
//! - `ReinvestedDistribution`, what a reinvestment was inferred from, kept on
//!   its row: `{ ex_date, cash_amount_per_share, shares_held }`.

use indexmap::IndexSet;

use super::plan::{ImportKind, Leg, Planned, BUY, CASH};
use crate::common::constants::REINVESTED_DISTRIBUTION;
use crate::common::holding_positions::value::{compare_text, gt, join_text, le, to_number, Literal, Num};
use crate::common::holding_positions::{quantity_before, Movement};
use crate::common::utils::hash128;
use crate::js::{self, Json};

/// Smaller steps in the adjusted-to-raw ratio than this share of the prior
/// close are the provider's rounding, not a payout.
const MIN_DISTRIBUTION_YIELD: f64 = 1e-4;

fn round(value: f64, places: i32) -> f64 {
    let factor = 10f64.powi(places);
    js::math_round(value * factor) / factor
}

struct Distribution {
    ex_date: Option<Json>,
    cash_amount: f64,
    close: Num,
}

fn distributions(bars: &[Json]) -> Vec<Distribution> {
    let figure = |bar: &Json, key: &str| to_number(bar.get(key));
    let mut distributions = Vec::new();
    for pair in bars.windows(2) {
        let (prior, bar) = (&pair[0], &pair[1]);
        let payout_share =
            1.0 - figure(prior, "adjustedClose") / figure(prior, "close") / (figure(bar, "adjustedClose") / figure(bar, "close"));
        if payout_share <= MIN_DISTRIBUTION_YIELD {
            continue;
        }
        distributions.push(Distribution {
            ex_date: bar.get("date").cloned(),
            cash_amount: round(figure(prior, "close") * payout_share, 6),
            close: Num::of(bar.get("close")),
        });
    }
    distributions
}

/// The cash distributions a fund went ex on within its bars, as
/// `Distribution`s. An adjusted series scales every close before an ex-date
/// by `1 - payout / prior close`, so the ratio of adjusted to raw close steps
/// by that factor on the ex-date.
///
/// A $1 payout on a $100 fund: the adjusted close before the ex-date is 99%
/// of the raw one, so the bars `2026-03-24` (close 100, adjusted 99) and
/// `2026-03-25` (close 99.5, adjusted 99.5) give
/// `[{ ex_date: "2026-03-25", cash_amount: 1, close: 99.5 }]`.
pub fn distributions_from_closes(bars: &[Json]) -> Vec<Json> {
    let json = |distribution: Distribution| -> Json {
        Literal::new()
            .opt("ex_date", distribution.ex_date)
            .num("cash_amount", distribution.cash_amount)
            .opt("close", distribution.close.json())
            .into()
    };
    distributions(bars).into_iter().map(json).collect()
}

pub const INFERRED_REINVESTMENT_NAME: &str = "Buy (inferred dividend reinvestment)";

/// Every inferred reinvestment's id, and its cash leg's, starts with it
/// (`PLAN_STATEMENT_ID_PREFIX` and `dividend-`), which tells it from a reported dividend.
pub const INFERRED_DIVIDEND_ID_PREFIX: &str = "plan-dividend-";

fn reinvestment_id(account_id: &str, security_id: Option<&Json>, ex_date: Option<&Json>) -> String {
    let key = [account_id, &join_text(security_id), &join_text(ex_date), REINVESTED_DISTRIBUTION].join("\0");
    format!("{INFERRED_DIVIDEND_ID_PREFIX}{}", hash128(&key))
}

/// One id per holding and ex-date, so a later import recognises the reinvestment it already wrote.
pub fn get_reinvestment_id(account_id: &str, security_id: &str, ex_date: &str) -> String {
    let key = [account_id, security_id, ex_date, REINVESTED_DISTRIBUTION].join("\0");
    format!("{INFERRED_DIVIDEND_ID_PREFIX}{}", hash128(&key))
}

/// A top-up's id names the rows that owe it, so importing the same rows again doesn't add it twice.
fn top_up_id(account_id: &str, security_id: Option<&Json>, ex_date: Option<&Json>, import_key: &str) -> String {
    let key = [account_id, &join_text(security_id), &join_text(ex_date), REINVESTED_DISTRIBUTION, import_key].join("\0");
    format!("{INFERRED_DIVIDEND_ID_PREFIX}{}", hash128(&key))
}

/// What [`plan_reinvestments`] takes: the TypeScript's `ReinvestmentInput`.
#[derive(Clone, Copy, Debug)]
pub struct ReinvestmentInput<'a> {
    pub account_id: &'a str,
    pub security_id: &'a str,
    pub iso_currency_code: &'a str,
    /// The public fund's daily closes (`DailyClose`s), as traded and dividend-adjusted.
    pub bars: &'a [Json],
    /// YYYY-MM-DD: ex-dates after `after` (the latest plan-statement row before the statement, or `None` for
    /// none) through the statement's last row are inferred.
    pub after: Option<&'a str>,
    pub through: &'a str,
    /// The holding's live movements, with the rows this import writes.
    pub movements: &'a [Json],
    /// Ids of the statement rows this import writes.
    pub writing: &'a IndexSet<String>,
    /// The holding's `EnteredPosition`s.
    pub entered: &'a [Json],
    /// Whether the holding's entered positions are being replaced by its transactions.
    pub replace: bool,
    /// Live ids in the account.
    pub live_ids: &'a IndexSet<String>,
    /// Ids already in the account: live, or found deleted by an earlier import attempt.
    pub existing_ids: &'a IndexSet<String>,
}

/// [`ReinvestmentInput`] as the preview has it: the security and the period's
/// end as the mapping and the statement's last row hold them, and the
/// movements already read.
pub(crate) struct Reinvestments<'a> {
    pub(crate) account_id: &'a str,
    pub(crate) security_id: Option<&'a Json>,
    pub(crate) iso_currency_code: &'a str,
    pub(crate) bars: &'a [Json],
    pub(crate) after: Option<&'a str>,
    pub(crate) through: Option<&'a Json>,
    pub(crate) movements: &'a [Movement],
    pub(crate) writing: &'a IndexSet<String>,
    pub(crate) entered: &'a [Json],
    pub(crate) replace: bool,
    pub(crate) live_ids: &'a IndexSet<String>,
    pub(crate) existing_ids: &'a IndexSet<String>,
}

/// `investment_transaction_id ?? ""`, as text.
fn id_text(movement: &Movement) -> String {
    join_text(movement.investment_transaction_id.as_ref())
}

pub(crate) fn plan_reinvestments_of(input: &Reinvestments) -> anyhow::Result<Vec<Planned>> {
    let spec = ImportKind::Dividend.spec();
    let after = input.after.map(|after| Json::String(after.to_string()));
    // A set of strings holds no id that is anything else.
    let writing = |movement: &Movement| match &movement.investment_transaction_id {
        None | Some(Json::Null) => input.writing.contains(""),
        Some(Json::String(id)) => input.writing.contains(id),
        Some(_) => false,
    };
    let previous: Vec<Movement> = input.movements.iter().filter(|m| !writing(m)).cloned().collect();
    let added: Vec<&Movement> = input.movements.iter().filter(|m| writing(m)).collect();
    // The holding's movements with the reinvestments planned so far, and those alone.
    let mut held: Vec<Movement> = input.movements.to_vec();
    let mut planned: Vec<Movement> = Vec::new();
    let mut transactions: Vec<Planned> = Vec::new();

    let mut add = |held: &mut Vec<Movement>,
                   planned: &mut Vec<Movement>,
                   id: String,
                   ex_date: Option<&Json>,
                   shares_held: f64,
                   cash_amount: f64,
                   close: Num| {
        let amount = round(shares_held * cash_amount, 2);
        if amount <= 0.0 {
            return;
        }
        let quantity = amount / close.value();
        let reinvested_distribution: Json = Literal::new()
            .opt("ex_date", ex_date.cloned())
            .num("cash_amount_per_share", cash_amount)
            .num("shares_held", shares_held)
            .into();
        let reinvestment = Leg {
            investment_transaction_id: Some(Json::String(id.clone())),
            account_id: input.account_id,
            security_id: input.security_id.cloned(),
            date: ex_date.cloned(),
            name: INFERRED_REINVESTMENT_NAME,
            amount,
            quantity,
            price: close,
            iso_currency_code: input.iso_currency_code,
            kind: BUY,
            subtype: spec.subtype,
            restated_from: None,
            reinvested_distribution: Some(reinvested_distribution),
        }
        .planned();
        held.push(reinvestment.movement.clone());
        planned.push(reinvestment.movement.clone());
        transactions.push(reinvestment);
        if let Some(cash) = spec.cash {
            transactions.push(
                Leg {
                    investment_transaction_id: Some(Json::String(format!("{id}-cash"))),
                    account_id: input.account_id,
                    security_id: Some(Json::Null),
                    date: ex_date.cloned(),
                    name: cash.name,
                    amount: -amount,
                    quantity: 0.0,
                    price: Num::Value(0.0),
                    iso_currency_code: input.iso_currency_code,
                    kind: CASH,
                    subtype: cash.subtype,
                    restated_from: None,
                    reinvested_distribution: None,
                }
                .planned(),
            );
        }
    };

    for Distribution { ex_date, cash_amount, close } in distributions(input.bars) {
        let ex_date = ex_date.as_ref();
        let id = reinvestment_id(input.account_id, input.security_id, ex_date);
        let in_period = (after.is_none() || gt(ex_date, after.as_ref())) && le(ex_date, input.through);
        if in_period && !input.existing_ids.contains(&id) {
            let shares = quantity_before(&held, input.entered, input.replace, ex_date)?.value();
            add(&mut held, &mut planned, id, ex_date, round(shares, 6), cash_amount, close);
            continue;
        }
        if !input.live_ids.contains(&id) {
            continue;
        }
        let added_key = added.iter().copied().chain(&planned).map(id_text).min_by(|a, b| compare_text(a, b)).unwrap_or_default();
        let top_up_id = top_up_id(input.account_id, input.security_id, ex_date, &added_key);
        if input.existing_ids.contains(&top_up_id) {
            continue;
        }
        // The written reinvestment was priced on the entered positions this import may now replace.
        let shares = quantity_before(&held, input.entered, input.replace, ex_date)?.value()
            - quantity_before(&previous, input.entered, false, ex_date)?.value();
        add(&mut held, &mut planned, top_up_id, ex_date, round(shares, 6), cash_amount, close);
    }
    Ok(transactions)
}

/// The reinvested distributions a holding restated from a collective trust is
/// owed: the trust keeps its payouts in its unit price, while the public fund
/// pays them out. On each ex-date in the statement's period, the shares held at
/// the start of the day × cash per share buys shares at that day's close, as a
/// dividend and its reinvestment. Earlier reinvestments count toward the shares
/// held on later ones.
///
/// An ex-date already written is left as it is. When this import's rows, or the
/// reinvestments it plans, are dated before a written one (a statement imported
/// after a later one), that reinvestment didn't count their shares, so a top-up
/// pays the payout on just the shares this import adds.
///
/// Returns `PlannedTransaction`s. A buy or sell among the movements without a
/// `date` string is an error.
pub fn plan_reinvestments(input: &ReinvestmentInput) -> anyhow::Result<Vec<Json>> {
    let security_id = Json::String(input.security_id.to_string());
    let through = Json::String(input.through.to_string());
    let planned = plan_reinvestments_of(&Reinvestments {
        account_id: input.account_id,
        security_id: Some(&security_id),
        iso_currency_code: input.iso_currency_code,
        bars: input.bars,
        after: input.after,
        through: Some(&through),
        movements: &Movement::all(input.movements),
        writing: input.writing,
        entered: input.entered,
        replace: input.replace,
        live_ids: input.live_ids,
        existing_ids: input.existing_ids,
    })?;
    Ok(planned.into_iter().map(|planned| planned.json).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::common::constants::PLAN_STATEMENT_ID_PREFIX;
    use crate::common::holding_positions::value::testing::{assert_close, assert_json};
    use crate::common::plan_statement::plan::PLAN_STATEMENT_ID_PATTERN;

    /// Bars whose adjusted closes carry the given payouts, built the way a provider back-adjusts them.
    fn bars_with(closes: &[(&str, f64)], payouts: &[(&str, f64)]) -> Vec<Json> {
        let mut bars: Vec<Json> = Vec::new();
        let mut factor = 1.0;
        for i in (0..closes.len()).rev() {
            let (date, close) = closes[i];
            bars.insert(0, json!({ "date": date, "close": close, "adjustedClose": close * factor }));
            let payout = payouts.iter().find(|(day, _)| *day == date).map(|(_, payout)| *payout);
            if let Some(payout) = payout.filter(|_| i > 0) {
                factor *= 1.0 - payout / closes[i - 1].1;
            }
        }
        bars
    }

    const CLOSES: [(&str, f64); 6] = [
        ("2026-03-02", 100.0),
        ("2026-03-03", 101.0),
        ("2026-03-04", 99.0),
        ("2026-03-05", 100.0),
        ("2026-06-01", 110.0),
        ("2026-06-02", 108.0),
    ];
    const PAYOUTS: [(&str, f64); 2] = [("2026-03-04", 1.5), ("2026-06-02", 0.75)];

    #[test]
    fn reads_each_payout_from_the_step_in_the_adjusted_to_raw_ratio_at_the_ex_dates_close() {
        let bars = bars_with(&CLOSES, &PAYOUTS);
        assert_json(
            &Json::Array(distributions_from_closes(&bars)),
            json!([{ "ex_date": "2026-03-04", "cash_amount": 1.5, "close": 99 }, { "ex_date": "2026-06-02", "cash_amount": 0.75, "close": 108 }]),
        );
    }

    #[test]
    fn a_typical_quarterly_payout_of_a_third_of_a_percent_is_read() {
        let bars = bars_with(&CLOSES, &[("2026-03-04", 0.33)]);
        assert_json(&Json::Array(distributions_from_closes(&bars)), json!([{ "ex_date": "2026-03-04", "cash_amount": 0.33, "close": 99 }]));
    }

    #[test]
    fn a_series_with_no_payouts_or_one_rounded_to_a_few_digits_has_none() {
        assert!(distributions_from_closes(&bars_with(&CLOSES, &[])).is_empty());
        // `Number(adjustedClose.toPrecision(7))`.
        let mut rounded = bars_with(&CLOSES, &[("2026-03-04", 1.5)]);
        for bar in &mut rounded {
            let adjusted: f64 = format!("{:.6e}", bar["adjustedClose"].as_f64().unwrap()).parse().unwrap();
            bar["adjustedClose"] = js::num(adjusted);
        }
        let ex_dates: Vec<Json> = distributions_from_closes(&rounded).iter().map(|d| d["ex_date"].clone()).collect();
        assert_eq!(ex_dates, [json!("2026-03-04")]);
    }

    #[test]
    fn a_step_the_other_way_isnt_a_payout() {
        let mut bars = bars_with(&CLOSES, &[]);
        for bar in bars.iter_mut().take(2) {
            bar["adjustedClose"] = js::num(bar["close"].as_f64().unwrap() * 1.01);
        }
        assert!(distributions_from_closes(&bars).is_empty());
    }

    #[test]
    fn a_bar_missing_a_close_still_yields_a_distribution_with_no_amount() {
        // NaN is not `<=` the threshold, so the row is kept, and JSON writes its amount as null.
        let bars = [json!({ "date": "2026-03-02", "close": 100, "adjustedClose": 99 }), json!({ "date": "2026-03-03", "adjustedClose": 99 })];
        assert_json(&Json::Array(distributions_from_closes(&bars)), json!([{ "ex_date": "2026-03-03", "cash_amount": null }]));
    }

    fn buy(date: &str, quantity: f64, price: f64, id: Option<&str>) -> Json {
        let mut movement = json!({ "date": date, "type": "buy", "quantity": quantity, "amount": quantity * price, "price": price });
        if let Some(id) = id {
            movement["investment_transaction_id"] = json!(id);
        }
        movement
    }

    fn ids(ids: &[&str]) -> IndexSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    /// The input the TypeScript tests start from, with the parts they vary.
    struct Case {
        bars: Vec<Json>,
        after: Option<&'static str>,
        through: &'static str,
        movements: Vec<Json>,
        entered: Vec<Json>,
        replace: bool,
        writing: IndexSet<String>,
        live_ids: IndexSet<String>,
        existing_ids: IndexSet<String>,
    }

    impl Default for Case {
        fn default() -> Self {
            Case {
                bars: bars_with(&CLOSES, &PAYOUTS),
                after: None,
                through: "2026-06-30",
                movements: vec![buy("2026-03-02", 10.0, 100.0, None)],
                entered: Vec::new(),
                replace: false,
                writing: IndexSet::new(),
                live_ids: IndexSet::new(),
                existing_ids: IndexSet::new(),
            }
        }
    }

    impl Case {
        fn plan(&self) -> Vec<Json> {
            plan_reinvestments(&ReinvestmentInput {
                account_id: "acct-1",
                security_id: "sec-fund",
                iso_currency_code: "USD",
                bars: &self.bars,
                after: self.after,
                through: self.through,
                movements: &self.movements,
                writing: &self.writing,
                entered: &self.entered,
                replace: self.replace,
                live_ids: &self.live_ids,
                existing_ids: &self.existing_ids,
            })
            .unwrap()
        }

        fn buys(&self) -> Vec<Json> {
            self.plan().into_iter().filter(|t| t["transaction"]["type"] == "buy").collect()
        }

        fn dates(&self) -> Vec<Json> {
            self.buys().iter().map(|t| t["transaction"]["date"].clone()).collect()
        }
    }

    #[test]
    fn each_ex_date_buys_shares_held_times_payout_at_its_close_as_a_dividend_and_its_reinvestment() {
        let planned = Case::default().plan();
        let id = get_reinvestment_id("acct-1", "sec-fund", "2026-03-04");
        assert_json(
            &planned[0],
            json!({
                "transaction": {
                    "investment_transaction_id": id,
                    "account_id": "acct-1",
                    "security_id": "sec-fund",
                    "date": "2026-03-04",
                    "name": "Buy (inferred dividend reinvestment)",
                    "amount": 15,
                    "quantity": 15.0 / 99.0,
                    "price": 99,
                    "iso_currency_code": "USD",
                    "type": "buy",
                    "subtype": "dividend reinvestment",
                    "source": "manual",
                },
                "reinvested_distribution": { "ex_date": "2026-03-04", "cash_amount_per_share": 1.5, "shares_held": 10 },
            }),
        );
        assert_json(
            &planned[1],
            json!({
                "transaction": {
                    "investment_transaction_id": format!("{id}-cash"),
                    "account_id": "acct-1",
                    "security_id": null,
                    "date": "2026-03-04",
                    "name": "Dividend",
                    "amount": -15,
                    "quantity": 0,
                    "price": 0,
                    "iso_currency_code": "USD",
                    "type": "cash",
                    "subtype": "dividend",
                    "source": "manual",
                },
            }),
        );
    }

    #[test]
    fn a_later_payout_counts_the_shares_an_earlier_one_reinvested() {
        let second = &Case::default().buys()[1];
        let held = 10.0 + 15.0 / 99.0;
        assert_close(&second["reinvested_distribution"]["shares_held"], held, 6);
        assert_json(&second["transaction"]["amount"], js::num(js::math_round(held * 0.75 * 100.0) / 100.0));
    }

    #[test]
    fn shares_bought_on_the_ex_date_dont_earn_its_payout() {
        let case = Case { movements: vec![buy("2026-03-02", 10.0, 100.0, None), buy("2026-03-04", 5.0, 100.0, None)], ..Default::default() };
        assert_json(&case.buys()[0]["reinvested_distribution"]["shares_held"], json!(10));
    }

    #[test]
    fn an_ex_date_after_the_statements_last_day_waits_for_a_statement_that_covers_it() {
        assert_eq!(Case { through: "2026-06-01", ..Default::default() }.dates(), [json!("2026-03-04")]);
        assert_eq!(Case { through: "2026-06-02", ..Default::default() }.dates(), [json!("2026-03-04"), json!("2026-06-02")]);
    }

    #[test]
    fn an_ex_date_on_or_before_the_latest_earlier_plan_statement_row_was_an_earlier_imports_to_infer() {
        assert_eq!(Case { after: Some("2026-03-04"), ..Default::default() }.dates(), [json!("2026-06-02")]);
        assert_eq!(Case { after: Some("2026-03-03"), ..Default::default() }.dates(), [json!("2026-03-04"), json!("2026-06-02")]);
    }

    #[test]
    fn an_ex_date_already_written_is_left_alone_and_its_shares_count_toward_the_next() {
        let id = get_reinvestment_id("acct-1", "sec-fund", "2026-03-04");
        let written = buy("2026-03-04", 1.0, 99.0, Some(&id));
        let case = Case { existing_ids: ids(&[&id]), movements: vec![buy("2026-03-02", 10.0, 100.0, None), written], ..Default::default() };
        assert_eq!(case.dates(), [json!("2026-06-02")]);
        assert_json(&case.buys()[0]["reinvested_distribution"]["shares_held"], json!(11));
    }

    #[test]
    fn nothing_held_on_an_ex_date_is_owed_nothing() {
        assert!(Case { movements: vec![buy("2026-06-02", 10.0, 100.0, None)], ..Default::default() }.buys().is_empty());
    }

    #[test]
    fn an_entered_position_counts_unless_the_transactions_are_replacing_it() {
        let entered = vec![json!({ "snapshot_id": "s1", "date": "2026-03-02", "quantity": 20, "cost_basis": null, "institution_price": 100 })];
        let kept = Case { entered: entered.clone(), ..Default::default() };
        assert_json(&kept.buys()[0]["reinvested_distribution"]["shares_held"], json!(20));
        let replaced = Case { entered, replace: true, ..Default::default() };
        assert_json(&replaced.buys()[0]["reinvested_distribution"]["shares_held"], json!(10));
    }

    #[test]
    fn each_holding_and_ex_date_gets_its_own_id() {
        let ids: IndexSet<String> = [
            get_reinvestment_id("acct-1", "sec-fund", "2026-03-04"),
            get_reinvestment_id("acct-1", "sec-fund", "2026-06-02"),
            get_reinvestment_id("acct-1", "sec-other", "2026-03-04"),
            get_reinvestment_id("acct-2", "sec-fund", "2026-03-04"),
        ]
        .into_iter()
        .collect();
        assert_eq!(ids.len(), 4);
        for id in &ids {
            assert!(id.starts_with(INFERRED_DIVIDEND_ID_PREFIX) && id.len() == INFERRED_DIVIDEND_ID_PREFIX.len() + 32);
            assert!(PLAN_STATEMENT_ID_PATTERN.is_match(id) && PLAN_STATEMENT_ID_PATTERN.is_match(&format!("{id}-cash")));
        }
        assert_eq!(INFERRED_DIVIDEND_ID_PREFIX, format!("{PLAN_STATEMENT_ID_PREFIX}dividend-"));
        // The id `getReinvestmentId` gives under Bun.
        assert_eq!(get_reinvestment_id("acct-1", "sec-fund", "2026-03-04"), "plan-dividend-f31f1d8d6001087248b026c92b3e8a52");
    }

    // Top-ups for rows dated before a written reinvestment. The 03-04 reinvestment
    // was written on 10 shares; this import adds 4 shares bought on 03-03.
    fn written_id() -> String {
        get_reinvestment_id("acct-1", "sec-fund", "2026-03-04")
    }

    fn top_up_case() -> Case {
        let written = buy("2026-03-04", 15.0 / 99.0, 99.0, Some(&written_id()));
        let back_dated = buy("2026-03-03", 4.0, 100.0, Some("plan-new-row"));
        Case {
            through: "2026-03-31",
            movements: vec![buy("2026-03-02", 10.0, 100.0, Some("plan-old-row")), written, back_dated],
            writing: ids(&["plan-new-row"]),
            live_ids: ids(&[&written_id()]),
            existing_ids: ids(&[&written_id()]),
            ..Default::default()
        }
    }

    #[test]
    fn top_ups_pay_the_payout_on_just_the_shares_the_earlier_rows_add() {
        let top_up = &top_up_case().buys()[0];
        assert_ne!(top_up["transaction"]["investment_transaction_id"], json!(written_id()));
        assert_json(&top_up["transaction"]["date"], json!("2026-03-04"));
        assert_json(&top_up["transaction"]["amount"], json!(6));
        assert_json(&top_up["transaction"]["price"], json!(99));
        assert_json(&top_up["reinvested_distribution"], json!({ "ex_date": "2026-03-04", "cash_amount_per_share": 1.5, "shares_held": 4 }));
    }

    #[test]
    fn top_ups_reach_written_reinvestments_after_the_statement_too_compounding_through_them() {
        // 06-02 lies after the statement and isn't written, so it's a later statement's to infer.
        assert_eq!(Case { through: "2026-03-03", ..top_up_case() }.dates(), [json!("2026-03-04")]);
        let june = get_reinvestment_id("acct-1", "sec-fund", "2026-06-02");
        let mut movements = top_up_case().movements;
        movements.push(buy("2026-06-02", 0.07, 108.0, Some(&june)));
        let with_june = Case {
            through: "2026-03-03",
            movements,
            live_ids: ids(&[&written_id(), &june]),
            existing_ids: ids(&[&written_id(), &june]),
            ..top_up_case()
        };
        assert_eq!(with_june.dates(), [json!("2026-03-04"), json!("2026-06-02")]);
        assert_close(&with_june.buys()[1]["reinvested_distribution"]["shares_held"], 4.0 + 6.0 / 99.0, 6);
    }

    #[test]
    fn top_ups_arent_owed_for_a_written_reinvestment_before_the_earlier_rows_or_one_someone_deleted() {
        let mut after = top_up_case().movements[..2].to_vec();
        after.push(buy("2026-03-05", 4.0, 100.0, Some("plan-new-row")));
        assert!(Case { movements: after, ..top_up_case() }.buys().is_empty());
        assert!(Case { live_ids: IndexSet::new(), ..top_up_case() }.buys().is_empty());
    }

    #[test]
    fn top_ups_are_owed_for_this_imports_own_earlier_reinvestments_too_under_an_id_naming_them() {
        // Nothing new from the statement, but 03-04 is now inferred before the written 06-02.
        let june = get_reinvestment_id("acct-1", "sec-fund", "2026-06-02");
        let reimport = |bars: Vec<Json>| Case {
            bars,
            through: "2026-03-31",
            movements: vec![buy("2026-03-02", 10.0, 100.0, Some("plan-old-row")), buy("2026-06-02", 0.07, 108.0, Some(&june))],
            live_ids: ids(&[&june]),
            existing_ids: ids(&[&june]),
            ..Default::default()
        };
        let top_up = reimport(bars_with(&CLOSES, &PAYOUTS)).buys()[1].clone();
        assert_json(&top_up["transaction"]["date"], json!("2026-06-02"));
        assert_close(&top_up["reinvested_distribution"]["shares_held"], 15.0 / 99.0, 6);
        let other = reimport(bars_with(&CLOSES, &[("2026-03-03", 1.0), ("2026-06-02", 0.75)])).buys();
        assert_ne!(other[1]["transaction"]["investment_transaction_id"], top_up["transaction"]["investment_transaction_id"]);
    }

    #[test]
    fn top_ups_compare_against_the_position_the_written_reinvestment_was_priced_on_even_when_replacing_it() {
        // The 03-04 reinvestment paid on 10 entered shares; this import replaces them with 4 bought on 03-03.
        let entered_ten = vec![json!({ "snapshot_id": "s1", "date": "2026-03-01", "quantity": 10, "cost_basis": null, "institution_price": 100 })];
        let movements = top_up_case().movements[1..].to_vec();
        let replacing = Case { movements, entered: entered_ten, replace: true, ..top_up_case() };
        assert!(replacing.buys().is_empty());
    }

    #[test]
    fn top_ups_arent_added_twice_when_the_same_rows_are_imported_again() {
        let top_up = top_up_case().buys()[0]["transaction"]["investment_transaction_id"].as_str().unwrap().to_string();
        let again = Case { existing_ids: ids(&[&written_id(), &top_up]), ..top_up_case() };
        assert!(again.buys().is_empty());
    }
}
