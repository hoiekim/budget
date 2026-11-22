//! `src/common/holding-positions.ts`: the one derivation of a holding's
//! positions from its transactions, shared by the holding values and the
//! plan-statement import (which needs the shares held on an ex-date).
//!
//! Positions are walked in date order over every live buy and sell. Each
//! entered holding snapshot is a reset point: the position becomes its
//! quantity and cost at the end of its day, and later transactions apply on
//! top. Sales subtract from the running position. With `replace`, entered
//! snapshots are ignored and the holding is the transactions' alone.
//!
//! Movements (`Movement`: an investment transaction's `date`, `type`,
//! `quantity`, `amount`, `price` and optional `investment_transaction_id`),
//! entered positions (`EnteredPosition`: `snapshot_id`, `date`, `quantity`,
//! `cost_basis`, `institution_price`) and the positions and gaps that come
//! back are JSON objects with the TypeScript's keys. A figure that is `null`
//! or missing counts as it does in JavaScript arithmetic (0 and NaN). Where
//! the TypeScript throws a `TypeError` (a buy or sell without a `date`
//! string), the function returns an error.

pub(crate) mod value;

use std::cmp::Ordering;

use anyhow::bail;
use indexmap::{IndexMap, IndexSet};

use self::value::{
    compare_text, is_text, lt, math_max, math_min, nullish, or_else, sort_by, sort_default, text, text_to_number,
    three_way, to_number, to_text, Key, Literal, Num,
};
use crate::common::constants::PLAN_STATEMENT_ID_PREFIX;
use crate::js::{self, Json};

/// `InvestmentTransactionType.Buy` and `.Sell`.
const BUY: &str = "buy";
const SELL: &str = "sell";

const QUANTITY_EPSILON: f64 = 1e-6;

/// The most months `derive_positions` steps through after a holding's first
/// position. A hundred thousand years: reached only when a date or
/// `through_month` is not a calendar month, where the TypeScript's loop runs
/// until the process is out of memory.
const MAX_MONTHS: usize = 1_200_000;

/// Whether a holding with this transaction has its positions derived from its transactions.
pub fn is_derived_position_transaction_id(investment_transaction_id: &str) -> bool {
    investment_transaction_id.starts_with(PLAN_STATEMENT_ID_PREFIX)
}

/// What the walk reads of a movement. The figures are held as JavaScript
/// holds them, so one this crate planned a moment ago keeps a quantity JSON
/// could not write (a share count from a zero close).
#[derive(Clone, Debug)]
pub(crate) struct Movement {
    pub(crate) investment_transaction_id: Option<Json>,
    pub(crate) date: Option<Json>,
    pub(crate) kind: Option<Json>,
    pub(crate) quantity: Num,
    pub(crate) amount: Num,
    pub(crate) price: Num,
    /// Not read by the walk: what the plan-statement preview tells holdings and reported dividends by.
    pub(crate) subtype: Option<Json>,
    pub(crate) security_id: Option<Json>,
}

impl Movement {
    pub(crate) fn of(movement: &Json) -> Movement {
        Movement {
            investment_transaction_id: movement.get("investment_transaction_id").cloned(),
            date: movement.get("date").cloned(),
            kind: movement.get("type").cloned(),
            quantity: Num::of(movement.get("quantity")),
            amount: Num::of(movement.get("amount")),
            price: Num::of(movement.get("price")),
            subtype: movement.get("subtype").cloned(),
            security_id: movement.get("security_id").cloned(),
        }
    }

    pub(crate) fn all(movements: &[Json]) -> Vec<Movement> {
        movements.iter().map(Movement::of).collect()
    }
}

/// `byId`: a missing id sorts as the empty one.
fn by_id(a: Option<&Json>, b: Option<&Json>) -> f64 {
    let empty = Json::String(String::new());
    three_way(a.or(Some(&empty)), b.or(Some(&empty)))
}

/// Within a day, shares arrive before any leave, so a same-day sale isn't capped at what came earlier.
fn buys_first(a: &Movement, b: &Movement) -> f64 {
    let leaves = |m: &Movement| f64::from(u8::from(!is_text(m.kind.as_ref(), BUY)));
    leaves(a) - leaves(b)
}

/// The month after a `YYYY-MM`.
fn add_month(year_month: &str) -> String {
    let mut parts = year_month.split('-').map(text_to_number);
    let year = parts.next().unwrap_or(f64::NAN);
    let month = parts.next().unwrap_or(f64::NAN);
    if month == 12.0 {
        format!("{}-01", js::number_to_string(year + 1.0))
    } else {
        format!("{}-{:0>2}", js::number_to_string(year), js::number_to_string(month + 1.0))
    }
}

struct Running {
    quantity: Num,
    /// `Null` when an entered position with no cost basis left it unknown.
    cost_basis: Num,
}

fn apply_movement(running: &mut Running, m: &Movement) {
    if is_text(m.kind.as_ref(), BUY) {
        running.quantity = Num::Value(running.quantity.value() + m.quantity.value());
        if !running.cost_basis.is_null() {
            running.cost_basis = Num::Value(running.cost_basis.value() + m.amount.value());
        }
    } else if running.quantity.value() > 0.0 {
        // A sale takes basis in proportion to the shares leaving, at the average
        // cost of the whole position, entered shares included.
        let sold = math_min(m.quantity.value().abs(), running.quantity.value());
        if !running.cost_basis.is_null() {
            let cost = running.cost_basis.value();
            running.cost_basis = Num::Value(cost - (cost / running.quantity.value()) * sold);
        }
        running.quantity = Num::Value(running.quantity.value() - sold);
    }
}

/// `Math.max(0, costBasis)`, with an unknown cost left unknown.
fn known_cost(cost_basis: Num) -> Num {
    if cost_basis.is_null() {
        Num::Null
    } else {
        Num::Value(math_max(0.0, cost_basis.value()))
    }
}

/// The entered position the walk resets to on each date, by the date as the
/// position gives it.
fn reset_points(entered: &[Json]) -> IndexMap<Key, &Json> {
    let mut sorted: Vec<&Json> = entered.iter().collect();
    sort_by(&mut sorted, |a, b| {
        or_else(three_way(a.get("date"), b.get("date")), || by_id(a.get("snapshot_id"), b.get("snapshot_id")))
    });
    let mut points = IndexMap::new();
    for position in sorted {
        points.insert(Key::of(position.get("date")), position);
    }
    points
}

/// The entered position the walk resets to on each date; on a day with two,
/// the later id wins. A `Map<string, EnteredPosition>` in the order the dates
/// first appear once sorted; a position whose `date` is not a string is
/// keyed by its text (`"null"`).
pub fn entered_reset_points(entered: &[Json]) -> IndexMap<String, Json> {
    let mut points = IndexMap::new();
    for (date, position) in reset_points(entered) {
        let date = match date {
            Key::Text(date) => date,
            other => to_text(other.value().as_ref()),
        };
        points.insert(date, position.clone());
    }
    points
}

/// A `Position`: `{ quantity, costBasis, price }`.
#[derive(Clone, Copy)]
struct Position {
    quantity: Num,
    cost_basis: Num,
    price: Num,
}

impl Position {
    fn json(&self) -> Json {
        Literal::new()
            .opt("quantity", self.quantity.json())
            .opt("costBasis", self.cost_basis.json())
            .opt("price", self.price.json())
            .into()
    }
}

struct Walk {
    /// `PositionGap`s: `{ date, stored, explained }`.
    gaps: Vec<Json>,
    /// The position at the end of each walked day.
    points: IndexMap<Key, Position>,
    /// The position after the last walked day.
    running: Running,
}

/// Every buy and sell in date order (within a day, buys before sells, then
/// by id), each entered position a reset point at the end of its day unless
/// `replace`, stopping before `before` when given.
fn walk_positions(movements: &[Movement], entered: &[Json], replace: bool, before: Option<&Json>) -> anyhow::Result<Walk> {
    // Each buy and sell with the day of its date.
    let mut steps: Vec<(String, &Movement)> = Vec::new();
    for m in movements {
        if !is_text(m.kind.as_ref(), BUY) && !is_text(m.kind.as_ref(), SELL) {
            continue;
        }
        steps.push((js::js_slice_start(text(m.date.as_ref(), "a movement's date")?, 10), m));
    }
    sort_by(&mut steps, |(a_date, a), (b_date, b)| match compare_text(a_date, b_date) {
        Ordering::Less => -1.0,
        Ordering::Greater => 1.0,
        Ordering::Equal => {
            or_else(buys_first(a, b), || by_id(a.investment_transaction_id.as_ref(), b.investment_transaction_id.as_ref()))
        }
    });
    let entered_by_date = reset_points(entered);

    let days: IndexSet<Key> = steps.iter().map(|(date, _)| Key::text(date)).chain(entered_by_date.keys().cloned()).collect();
    let mut dates: Vec<Option<Json>> = days.iter().map(Key::value).collect();
    sort_default(&mut dates);
    dates.retain(|date| before.is_none() || lt(date.as_ref(), before));

    let mut running = Running { quantity: Num::Value(0.0), cost_basis: Num::Value(0.0) };
    let mut price = Num::Value(0.0);
    let mut next = 0;
    let mut gaps = Vec::new();
    let mut points = IndexMap::new();
    for date in &dates {
        let mut moved = false;
        while next < steps.len() && is_text(date.as_ref(), &steps[next].0) {
            let m = steps[next].1;
            next += 1;
            apply_movement(&mut running, m);
            if m.price.value() > 0.0 {
                price = m.price;
            }
            moved = true;
        }
        let own = entered_by_date.get(&Key::of(date.as_ref())).filter(|own| js::truthy(own));
        if let Some(own) = own {
            let stored = Num::of(own.get("quantity"));
            let explained = (stored.value() - running.quantity.value()).abs() <= QUANTITY_EPSILON;
            if !explained {
                gaps.push(
                    Literal::new()
                        .opt("date", date.clone())
                        .opt("stored", own.get("quantity").cloned())
                        .opt("explained", running.quantity.json())
                        .into(),
                );
            }
            if !replace {
                // An entered position is the holding at the end of its day. With no
                // cost of its own, the cost stays what the walk knows only if the walk
                // already explains its shares; otherwise it's unknown until a later
                // entry gives one.
                let cost_basis = own.get("cost_basis");
                if !nullish(cost_basis) {
                    running.cost_basis = Num::of(cost_basis);
                } else if !explained {
                    running.cost_basis = Num::Null;
                }
                running.quantity = stored;
                let institution_price = own.get("institution_price");
                if !nullish(institution_price) && to_number(institution_price) > 0.0 {
                    price = Num::of(institution_price);
                }
            }
        }
        if !moved && replace {
            continue;
        }
        points.insert(
            Key::of(date.as_ref()),
            Position { quantity: running.quantity, cost_basis: known_cost(running.cost_basis), price },
        );
    }
    Ok(Walk { gaps, points, running })
}

/// The shares held at the start of `date`, as [`position_before`] counts
/// them. `date` is the value the caller has for the day: with none
/// (`undefined`), every day is walked.
pub(crate) fn quantity_before(movements: &[Movement], entered: &[Json], replace: bool, date: Option<&Json>) -> anyhow::Result<Num> {
    Ok(walk_positions(movements, entered, replace, date)?.running.quantity)
}

/// What [`position_before`] takes: `{ movements, entered, date, replace? }`.
#[derive(Clone, Copy, Debug, Default)]
pub struct PositionBeforeInput<'a> {
    pub movements: &'a [Json],
    pub entered: &'a [Json],
    /// YYYY-MM-DD
    pub date: &'a str,
    pub replace: bool,
}

/// The position held at the start of `date`: earlier days' movements,
/// entered positions as end-of-day resets. `{ quantity, costBasis }`, the
/// cost `null` when an entered position left it unknown.
pub fn position_before(input: &PositionBeforeInput) -> anyhow::Result<Json> {
    let date = Json::String(input.date.to_string());
    let Walk { running, .. } = walk_positions(&Movement::all(input.movements), input.entered, input.replace, Some(&date))?;
    Ok(Literal::new().opt("quantity", running.quantity.json()).opt("costBasis", known_cost(running.cost_basis).json()).into())
}

/// What [`derive_positions`] takes: `{ movements, entered, throughMonth, replace? }`.
#[derive(Clone, Copy, Debug, Default)]
pub struct DerivePositionsInput<'a> {
    pub movements: &'a [Json],
    pub entered: &'a [Json],
    /// YYYY-MM
    pub through_month: &'a str,
    pub replace: bool,
}

/// What [`derive_positions`] returns: `{ gaps, positions }`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DerivedPositions {
    /// `PositionGap`s, `{ date, stored, explained }`: an entered position the walk up to its date doesn't account for.
    pub gaps: Vec<Json>,
    /// `DatedPosition`s, `{ date, position: { quantity, costBasis, price } }`.
    pub positions: Vec<Json>,
}

impl DerivedPositions {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        Literal::new().set("gaps", self.gaps.clone()).set("positions", self.positions.clone()).into()
    }
}

/// [`derive_positions`] over movements already read.
pub(crate) fn derive_positions_of(
    movements: &[Movement],
    entered: &[Json],
    through_month: &str,
    replace: bool,
) -> anyhow::Result<DerivedPositions> {
    let Walk { gaps, points, .. } = walk_positions(movements, entered, replace, None)?;
    let mut point_dates: Vec<Option<Json>> = points.keys().map(Key::value).collect();
    sort_default(&mut point_dates);
    let mut openings: Vec<(String, &Position)> = Vec::new();
    if let Some(first_date) = point_dates.first() {
        let mut i = 0;
        let mut last: Option<&Position> = None;
        let mut month = add_month(&js::js_slice_start(text(first_date.as_ref(), "a position's date")?, 7));
        let mut months = 0;
        while compare_text(&month, through_month) != Ordering::Greater {
            let first = format!("{month}-01");
            let first_day = Json::String(first.clone());
            while i < point_dates.len() && lt(point_dates[i].as_ref(), Some(&first_day)) {
                last = points.get(&Key::of(point_dates[i].as_ref()));
                i += 1;
            }
            if let Some(last) = last {
                if !points.contains_key(&Key::text(&first)) {
                    openings.push((first, last));
                }
            }
            let next = add_month(&month);
            months += 1;
            if next == month || months > MAX_MONTHS {
                bail!("the months from {month} through {through_month} never end");
            }
            month = next;
        }
    }
    let mut positions: Vec<(Option<Json>, &Position)> = points.iter().map(|(date, position)| (date.value(), position)).collect();
    positions.extend(openings.into_iter().map(|(date, position)| (Some(Json::String(date)), position)));
    sort_by(&mut positions, |(a, _), (b, _)| three_way(a.as_ref(), b.as_ref()));
    let positions =
        positions.into_iter().map(|(date, position)| Literal::new().opt("date", date).set("position", position.json()).into()).collect();
    Ok(DerivedPositions { gaps, positions })
}

/// A holding's positions from its transactions: one on every day with a
/// movement or an entry, and one on the 1st of every later month through
/// `through_month` (holdings are valued from the latest position in each
/// calendar month, with no carry-forward). Also the entered positions the
/// transactions don't explain.
pub fn derive_positions(input: &DerivePositionsInput) -> anyhow::Result<DerivedPositions> {
    derive_positions_of(&Movement::all(input.movements), input.entered, input.through_month, input.replace)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::value::testing::{assert_close, assert_json};
    use super::*;

    fn tx(date: &str, kind: &str, quantity: f64, amount: f64, price: f64) -> Json {
        json!({ "date": date, "type": kind, "quantity": quantity, "amount": amount, "price": price })
    }

    fn tx_with_id(date: &str, kind: &str, quantity: f64, amount: f64, price: f64, id: &str) -> Json {
        json!({ "date": date, "type": kind, "quantity": quantity, "amount": amount, "price": price, "investment_transaction_id": id })
    }

    fn entered(date: &str, quantity: f64) -> Json {
        json!({
            "snapshot_id": format!("holding-acct-1-sec-1-{}", date.replace('-', "")),
            "date": date,
            "quantity": quantity,
            "cost_basis": quantity * 3.0,
            "institution_price": 48,
        })
    }

    fn entered_with(date: &str, quantity: f64, over: Json) -> Json {
        let mut position = entered(date, quantity);
        for (key, value) in over.as_object().unwrap() {
            position[key.as_str()] = value.clone();
        }
        position
    }

    fn derive(movements: &[Json], entered: &[Json], through_month: &str, replace: bool) -> DerivedPositions {
        derive_positions(&DerivePositionsInput { movements, entered, through_month, replace }).unwrap()
    }

    fn last(result: &DerivedPositions) -> &Json {
        &result.positions.last().unwrap()["position"]
    }

    fn statement() -> Vec<Json> {
        vec![tx("2026-10-06", "buy", 10.0, 500.0, 50.0), tx("2026-11-03", "buy", 2.0, 104.0, 52.0), tx("2026-12-18", "buy", 0.5, 27.0, 54.0)]
    }

    #[test]
    fn a_position_on_each_movement_day_and_each_later_months_1st() {
        let result = derive(&statement(), &[], "2027-01", false);
        let days: Vec<Json> = result.positions.iter().map(|p| json!([p["date"], p["position"]["quantity"]])).collect();
        assert_json(
            &Json::Array(days),
            json!([["2026-10-06", 10], ["2026-11-01", 10], ["2026-11-03", 12], ["2026-12-01", 12], ["2026-12-18", 12.5], ["2027-01-01", 12.5]]),
        );
        assert_json(last(&result), json!({ "quantity": 12.5, "costBasis": 631, "price": 54 }));
        assert_json(&result.to_json()["gaps"], json!([]));
    }

    #[test]
    fn sales_draw_on_an_entered_position() {
        // Fees and a withdrawal after 100 entered units.
        let movements = [
            tx("2026-02-27", "sell", -0.2, -9.6, 48.0),
            tx("2026-03-31", "sell", -0.2, -9.6, 48.0),
            tx("2026-05-15", "sell", -20.0, -960.0, 48.0),
        ];
        let result = derive(&movements, &[entered("2026-01-02", 100.0)], "2026-06", false);
        assert_close(&last(&result)["quantity"], 79.6, 6);
    }

    #[test]
    fn a_sale_after_an_entered_position_takes_basis_at_the_average_cost_of_the_whole_position() {
        let movements = [tx("2026-02-01", "buy", 10.0, 500.0, 50.0), tx("2026-03-01", "sell", -5.0, -250.0, 50.0)];
        let result = derive(&movements, &[entered_with("2026-01-02", 100.0, json!({ "cost_basis": 300 }))], "2026-03", false);
        assert_json(&last(&result)["quantity"], json!(105));
        assert_close(&last(&result)["costBasis"], 800.0 - (800.0 / 110.0) * 5.0, 2);
    }

    #[test]
    fn each_entered_position_is_a_reset_point_and_the_ones_transactions_dont_explain_are_gaps() {
        let movements = [tx("2026-02-10", "buy", 10.0, 500.0, 50.0), tx("2026-04-10", "buy", 10.0, 500.0, 50.0)];
        let result = derive(&movements, &[entered("2026-01-02", 100.0), entered("2026-03-02", 50.0)], "2026-04", false);
        assert_json(&last(&result)["quantity"], json!(60));
        assert_json(
            &Json::Array(result.gaps.clone()),
            json!([{ "date": "2026-01-02", "stored": 100, "explained": 0 }, { "date": "2026-03-02", "stored": 50, "explained": 110 }]),
        );
    }

    #[test]
    fn replace_ignores_entered_positions_and_follows_the_transactions_alone() {
        let result = derive(&[tx("2026-02-10", "buy", 10.0, 500.0, 50.0)], &[entered("2026-01-02", 100.0)], "2026-02", true);
        assert_json(&last(&result)["quantity"], json!(10));
        let dates: Vec<&Json> = result.positions.iter().map(|p| &p["date"]).collect();
        assert_eq!(dates, vec![&json!("2026-02-10")]);
    }

    #[test]
    fn months_between_an_entered_position_and_the_first_movement_carry_its_price_not_zero() {
        let result = derive(&[tx("2026-04-10", "buy", 10.0, 500.0, 50.0)], &[entered("2026-01-02", 100.0)], "2026-04", false);
        let openings: Vec<Json> = result
            .positions
            .iter()
            .filter(|p| p["date"] == "2026-02-01" || p["date"] == "2026-03-01")
            .map(|p| json!([p["position"]["quantity"], p["position"]["price"]]))
            .collect();
        assert_json(&Json::Array(openings), json!([[100, 48], [100, 48]]));
    }

    #[test]
    fn an_entered_position_with_no_cost_leaves_the_cost_unknown_and_a_buy_on_top_doesnt_make_one_up() {
        let movements = [tx("2026-02-01", "buy", 10.0, 500.0, 50.0), tx("2026-02-27", "sell", -0.2, -9.6, 48.0)];
        let result = derive(&movements, &[entered_with("2026-01-02", 100.0, json!({ "cost_basis": null }))], "2026-03", false);
        assert!(result.positions.iter().all(|p| p["position"]["costBasis"].is_null()));
        assert_json(&last(&result)["quantity"], json!(109.8));
        assert_json(&last(&result)["costBasis"], Json::Null);
    }

    #[test]
    fn an_entry_with_no_cost_that_the_transactions_already_explain_keeps_their_cost() {
        let movements = [tx("2026-02-01", "buy", 10.0, 500.0, 50.0), tx("2026-03-01", "buy", 2.0, 104.0, 52.0)];
        let result = derive(&movements, &[entered_with("2026-02-02", 10.0, json!({ "cost_basis": null }))], "2026-03", false);
        assert_json(last(&result), json!({ "quantity": 12, "costBasis": 604, "price": 52 }));
    }

    #[test]
    fn a_later_entry_with_a_cost_makes_the_cost_known_again() {
        let positions = [
            entered_with("2026-01-02", 100.0, json!({ "cost_basis": null })),
            entered_with("2026-03-02", 50.0, json!({ "cost_basis": 150 })),
        ];
        let result = derive(&[tx("2026-04-01", "buy", 10.0, 500.0, 50.0)], &positions, "2026-04", false);
        assert_json(last(&result), json!({ "quantity": 60, "costBasis": 650, "price": 50 }));
    }

    #[test]
    fn a_movement_with_no_price_keeps_the_last_known_price() {
        let movements = [tx("2026-10-06", "buy", 10.0, 500.0, 50.0), tx("2026-10-20", "buy", 1.0, 0.0, 0.0)];
        let result = derive(&movements, &[], "2026-10", false);
        let position = &result.positions.iter().find(|p| p["date"] == "2026-10-20").unwrap()["position"];
        assert_json(position, json!({ "quantity": 11, "costBasis": 500, "price": 50 }));
    }

    #[test]
    fn on_one_day_buys_apply_before_sells_whatever_their_ids_so_a_same_day_fee_isnt_dropped() {
        // A rollover arriving and a fee leaving on the statement's first day; the fee's id sorts first.
        let movements =
            [tx_with_id("2026-10-06", "buy", 100.0, 5000.0, 50.0, "b"), tx_with_id("2026-10-06", "sell", -0.5, -25.0, 50.0, "a")];
        assert_json(&last(&derive(&movements, &[], "2026-10", false))["quantity"], json!(99.5));
    }

    fn before(date: &str, entered: &[Json], movements: &[Json]) -> Json {
        position_before(&PositionBeforeInput { movements, entered, date, replace: false }).unwrap()
    }

    #[test]
    fn position_before_counts_only_days_before_the_date() {
        // A movement on the date itself isn't held yet.
        assert_json(&before("2026-11-03", &[], &statement()), json!({ "quantity": 10, "costBasis": 500 }));
        assert_json(&before("2026-11-04", &[], &statement()), json!({ "quantity": 12, "costBasis": 604 }));
    }

    #[test]
    fn an_entered_position_resets_at_the_end_of_its_day() {
        let positions = [entered_with("2026-10-20", 100.0, json!({ "cost_basis": 300 }))];
        assert_json(&before("2026-10-20", &positions, &statement()), json!({ "quantity": 10, "costBasis": 500 }));
        assert_json(&before("2026-10-21", &positions, &statement()), json!({ "quantity": 100, "costBasis": 300 }));
        assert_json(&before("2026-11-04", &positions, &statement()), json!({ "quantity": 102, "costBasis": 404 }));
    }

    #[test]
    fn sales_draw_on_the_entered_shares_capped_at_whats_held() {
        let positions = [entered("2026-01-02", 100.0)];
        let sells = [tx("2026-02-01", "sell", -30.0, -1440.0, 48.0), tx("2026-03-01", "sell", -500.0, -24000.0, 48.0)];
        assert_json(&before("2026-02-02", &positions, &sells)["quantity"], json!(70));
        assert_json(&before("2026-03-02", &positions, &sells)["quantity"], json!(0));
    }

    #[test]
    fn position_before_agrees_with_the_derived_position_on_the_day_before() {
        let positions = [entered("2026-01-02", 100.0), entered("2026-03-02", 50.0)];
        let movements = [tx("2026-02-10", "buy", 10.0, 500.0, 50.0), tx("2026-04-10", "sell", -5.0, -250.0, 50.0)];
        let derived = derive(&movements, &positions, "2026-04", false);
        let april9 = derived.positions.iter().rfind(|p| p["date"].as_str().unwrap() < "2026-04-10").unwrap();
        assert_eq!(before("2026-04-10", &positions, &movements)["quantity"], april9["position"]["quantity"]);
    }

    #[test]
    fn two_entered_positions_on_one_day_the_later_id_is_the_one_the_walk_resets_to() {
        let a = entered_with("2026-01-02", 100.0, json!({ "snapshot_id": "holding-a" }));
        let b = entered_with("2026-01-02", 80.0, json!({ "snapshot_id": "holding-b" }));
        assert_eq!(entered_reset_points(&[b.clone(), a.clone()]).get("2026-01-02"), Some(&b));
        assert_json(&before("2026-01-03", &[a, b], &[])["quantity"], json!(80));
    }

    #[test]
    fn only_imported_rows_make_a_holdings_positions_derived() {
        assert!(is_derived_position_transaction_id(&format!("plan-{}", "a".repeat(32))));
        assert!(!is_derived_position_transaction_id("manual-123"));
    }

    #[test]
    fn a_null_or_missing_figure_counts_as_javascript_counts_it() {
        // `null` adds 0; a missing quantity is NaN from then on, which JSON writes as null.
        let null_quantity = json!({ "date": "2026-01-05", "type": "buy", "quantity": null, "amount": null, "price": null });
        let movements = [tx("2026-01-02", "buy", 3.0, 30.0, 10.0), null_quantity];
        assert_json(last(&derive(&movements, &[], "2026-01", false)), json!({ "quantity": 3, "costBasis": 30, "price": 10 }));
        let missing = json!({ "date": "2026-01-05", "type": "buy" });
        let movements = [tx("2026-01-02", "buy", 3.0, 30.0, 10.0), missing];
        assert_json(last(&derive(&movements, &[], "2026-01", false)), json!({ "quantity": null, "costBasis": null, "price": 10 }));
        // An entered position hands its own quantity on untouched, `null` and missing included.
        let entries = [json!({ "snapshot_id": "s", "date": "2026-01-03", "quantity": null, "cost_basis": null, "institution_price": null })];
        assert_json(&before("2026-01-04", &entries, &[]), json!({ "quantity": null, "costBasis": 0 }));
        let entries = [json!({ "snapshot_id": "s", "date": "2026-01-03" })];
        assert_json(&before("2026-01-04", &entries, &[]), json!({ "costBasis": null }));
    }

    #[test]
    fn a_buy_or_sell_without_a_date_is_an_error_and_other_types_are_passed_over() {
        let dateless = json!({ "type": "buy", "quantity": 1, "amount": 1, "price": 1 });
        assert!(derive_positions(&DerivePositionsInput { movements: &[dateless], through_month: "2026-01", ..Default::default() }).is_err());
        let cash = json!({ "type": "cash", "quantity": 0, "amount": -5, "price": 0 });
        assert_json(&derive(&[cash], &[], "2026-01", false).to_json(), json!({ "gaps": [], "positions": [] }));
    }

    #[test]
    fn months_step_as_text() {
        assert_eq!(add_month("2026-01"), "2026-02");
        assert_eq!(add_month("2026-09"), "2026-10");
        assert_eq!(add_month("2026-12"), "2027-01");
        assert_eq!(add_month("9999-12"), "10000-01");
        assert_eq!(add_month("garbage"), "NaN-NaN");
        assert_eq!(add_month(""), "0-NaN");
    }

    #[test]
    fn months_that_never_reach_the_last_one_are_an_error() {
        let movements = [tx("2026-1x-05", "buy", 1.0, 1.0, 1.0)];
        assert!(derive_positions(&DerivePositionsInput { movements: &movements, through_month: "2027-01", ..Default::default() }).is_err());
    }
}
