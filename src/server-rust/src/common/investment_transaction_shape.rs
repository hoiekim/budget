//! `src/common/investment-transaction-shape.ts`: the canonical form of a
//! hand-entered share movement, and the fields one edit of it writes.
//!
//! A row (`ShareMovement`) is a JSON object with `type`, `quantity`, `price`
//! and `amount`; a patch (`Partial<ShareMovement>`) is one with only the keys
//! to write. A figure that is `null` or missing is read as JavaScript
//! arithmetic reads it, and a figure that comes out NaN is written `null`,
//! as `JSON.stringify` writes it.

use crate::common::holding_positions::value::{is_number, is_text, to_number, Literal};
use crate::js::{self, Json};

/// `InvestmentTransactionType.Buy` and `.Sell`: the `ShareMovingType`s.
const BUY: &str = "buy";
const SELL: &str = "sell";

/// Whether a transaction type moves shares: a purchase or a sale.
pub fn moves_shares(kind: Option<&Json>) -> bool {
    is_text(kind, BUY) || is_text(kind, SELL)
}

/// Whether a row is one this reconciles: hand-entered, and a purchase or a
/// sale. `source` is the row's origin marker, `None` for `null` or `undefined`.
pub fn is_normalizable_row(source: Option<&str>, row: &Json) -> bool {
    source == Some("manual") && moves_shares(row.get("type"))
}

/// Canonical form for a hand-entered share movement:
///
///   price    >= 0, a unit price has no direction
///   quantity signed, positive when shares arrive
///   type     buy when shares arrive, sell when they leave
///   amount   price * quantity, so cash moves opposite to the shares
///
/// `subtype` is deliberately outside it: the editor offers the provider's whole
/// vocabulary, so deriving one from the direction would replace a real choice.
pub fn is_canonical(row: &Json, shares_arrive: Option<bool>) -> bool {
    let quantity = row.get("quantity");
    if to_number(row.get("price")) < 0.0 {
        return false;
    }
    // Pins WHICH direction, not merely that the fields agree on one: both
    // {buy, +5} and {sell, -5} satisfy every clause below.
    if let Some(shares_arrive) = shares_arrive {
        if !is_number(quantity, 0.0) && shares_arrive != (to_number(quantity) > 0.0) {
            return false;
        }
    }
    if to_number(quantity) > 0.0 && !is_text(row.get("type"), BUY) {
        return false;
    }
    if to_number(quantity) < 0.0 && !is_text(row.get("type"), SELL) {
        return false;
    }
    (to_number(row.get("amount")) - to_number(row.get("price")) * to_number(quantity)).abs() < 0.005
}

/// Which field the writer just edited; the others are derived to agree with it.
///
/// `quantity` and `type` pull opposite ways and each is right in its own case —
/// the mint names a type and varies quantity, someone picking Sell means the
/// reverse — so the writer passes this rather than it being inferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntentField {
    Quantity,
    Type,
    Price,
}

impl IntentField {
    /// The TypeScript's `"quantity" | "type" | "price"`.
    pub fn as_str(self) -> &'static str {
        match self {
            IntentField::Quantity => "quantity",
            IntentField::Type => "type",
            IntentField::Price => "price",
        }
    }

    pub fn parse(text: &str) -> Option<IntentField> {
        [IntentField::Quantity, IntentField::Type, IntentField::Price].into_iter().find(|intent| intent.as_str() == text)
    }
}

/// A canonical row before it is written out: the numbers as computed, NaN included.
struct Canonical {
    kind: &'static str,
    quantity: f64,
    price: f64,
    amount: f64,
}

fn normalize(row: &Json, intent: IntentField) -> Canonical {
    let quantity = row.get("quantity");
    let price = to_number(row.get("price")).abs();
    let shares = to_number(quantity).abs();
    let buys = is_text(row.get("type"), BUY);

    let shares_arrive = match intent {
        IntentField::Type => buys,
        IntentField::Quantity => to_number(quantity) >= 0.0,
        // Magnitude only; direction stays where the row had it, and the row
        // may itself be uncanonical, so `type` decides only if quantity is 0.
        IntentField::Price => {
            if js::truthy_opt(quantity) {
                to_number(quantity) > 0.0
            } else {
                buys
            }
        }
    };

    let quantity = if shares_arrive { shares } else { -shares };
    Canonical {
        kind: if shares_arrive { BUY } else { SELL },
        quantity,
        price,
        amount: js::math_round(price * quantity * 100.0) / 100.0,
    }
}

/// The canonical form of a row, with direction taken from `intent`:
/// `{ type, quantity, price, amount }`.
pub fn normalize_share_movement(row: &Json, intent: IntentField) -> Json {
    let canonical = normalize(row, intent);
    Literal::new()
        .set("type", canonical.kind)
        .num("quantity", canonical.quantity)
        .num("price", canonical.price)
        .num("amount", canonical.amount)
        .into()
}

/// The fields a single edit should write, given the row it started from.
///
/// Only what moved: a field the writer did not touch, and that reconciliation
/// agrees with, is left out so a concurrent edit of it is not overwritten.
pub fn shape_patch_for(source: Option<&str>, current: &Json, intent: IntentField, edited: &Json) -> Json {
    let merged: Json = Literal::new().spread(current).spread(edited).into();

    // Both halves here rather than split with the caller: four of the six types
    // move no shares, and a provider row is never reconciled at all — one
    // provider signs a movement the other way round on purpose.
    if !is_normalizable_row(source, &merged) {
        let mut patch = Literal::new().spread(edited);
        if intent != IntentField::Type {
            let amount = to_number(merged.get("quantity")) * to_number(merged.get("price")) * 100.0;
            patch = patch.num("amount", js::math_round(amount) / 100.0);
        }
        return patch.into();
    }

    let canonical = normalize(&merged, intent);
    let mut patch = Literal::new();
    if !is_text(current.get("type"), canonical.kind) {
        patch = patch.set("type", canonical.kind);
    }
    if !is_number(current.get("quantity"), canonical.quantity) {
        patch = patch.num("quantity", canonical.quantity);
    }
    if !is_number(current.get("price"), canonical.price) {
        patch = patch.num("price", canonical.price);
    }
    if !is_number(current.get("amount"), canonical.amount) {
        patch = patch.num("amount", canonical.amount);
    }
    patch.into()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::common::holding_positions::value::testing::{assert_close, assert_json};

    fn row(kind: &str, quantity: f64, price: f64, amount: f64) -> Json {
        json!({ "type": kind, "quantity": js::num(quantity), "price": js::num(price), "amount": js::num(amount) })
    }

    const SIGNS: [f64; 3] = [-1.0, 0.0, 1.0];
    // Every type the editor's dropdown offers, not only the two this reconciles:
    // a rule that speaks for two still has to be correct about the other four.
    const TYPES: [&str; 6] = ["buy", "sell", "cancel", "cash", "fee", "transfer"];
    const SHARE_TYPES: [&str; 2] = [BUY, SELL];
    const INTENTS: [IntentField; 3] = [IntentField::Quantity, IntentField::Type, IntentField::Price];

    // Enumerated rather than case-by-case: the editor persists one field group
    // at a time with no cross-field constraint, so every sign combination below
    // is a row someone can actually store.
    #[test]
    fn every_combination_a_manual_write_can_produce_comes_out_canonical() {
        let mut offenders: Vec<String> = Vec::new();
        for kind in SHARE_TYPES {
            for q_sign in SIGNS {
                for p_sign in SIGNS {
                    for intent in INTENTS {
                        let input = row(kind, q_sign * 5.0, p_sign * 30.0, -999.0);
                        let result = normalize_share_movement(&input, intent);
                        // The direction the edit meant, not merely a self-consistent one:
                        // both {buy, +5} and {sell, -5} agree with themselves.
                        let meant = match intent {
                            IntentField::Type => kind == BUY,
                            IntentField::Quantity => q_sign >= 0.0,
                            IntentField::Price => {
                                if q_sign != 0.0 {
                                    q_sign > 0.0
                                } else {
                                    kind == BUY
                                }
                            }
                        };
                        if !is_canonical(&result, Some(meant)) {
                            offenders.push(format!("{kind} q={} p={} intent={}", input["quantity"], input["price"], intent.as_str()));
                        }
                    }
                }
            }
        }
        assert_eq!(offenders, Vec::<String>::new());
    }

    #[test]
    fn normalizing_an_already_canonical_row_changes_nothing() {
        let mut unstable: Vec<String> = Vec::new();
        for kind in SHARE_TYPES {
            for q_sign in SIGNS {
                for p_sign in SIGNS {
                    for intent in INTENTS {
                        let once = normalize_share_movement(&row(kind, q_sign * 5.0, p_sign * 30.0, -999.0), intent);
                        let twice = normalize_share_movement(&once, intent);
                        if js::json_stringify(&once) != js::json_stringify(&twice) {
                            unstable.push(format!("{kind} q={} p={} intent={}", q_sign * 5.0, p_sign * 30.0, intent.as_str()));
                        }
                    }
                }
            }
        }
        assert_eq!(unstable, Vec::<String>::new());
    }

    // The two fields pull opposite ways and each is right in its own case, so
    // neither can be authoritative on its own.
    #[test]
    fn a_quantity_edit_decides_direction_which_is_what_the_reconciliation_mint_needs() {
        let result = normalize_share_movement(&row(BUY, -5.0, 30.0, -150.0), IntentField::Quantity);
        assert_json(&result, json!({ "type": "sell", "quantity": -5, "price": 30, "amount": -150 }));
    }

    #[test]
    fn a_type_edit_decides_direction_and_corrects_a_quantity_left_over_from_before() {
        let result = normalize_share_movement(&row(SELL, 5.0, 30.0, 150.0), IntentField::Type);
        assert_json(&result["quantity"], json!(-5));
        assert_close(&result["amount"], -150.0, 2);
    }

    #[test]
    fn a_price_edit_changes_magnitude_without_moving_direction() {
        let bought = normalize_share_movement(&row(BUY, 10.0, 12.0, 100.0), IntentField::Price);
        assert_json(&bought["quantity"], json!(10));
        assert_close(&bought["amount"], 120.0, 2);

        let sold = normalize_share_movement(&row(SELL, -10.0, 12.0, -100.0), IntentField::Price);
        assert_json(&sold["quantity"], json!(-10));
        assert_close(&sold["amount"], -120.0, 2);
    }

    // Flipping only `type` on a negative amount leaves a sale carrying a
    // negative price — a differently inconsistent row, not a consistent one.
    #[test]
    fn a_negative_price_never_survives_whichever_field_carried_the_intent() {
        for intent in INTENTS {
            let result = normalize_share_movement(&row(SELL, 5.0, -30.0, -150.0), intent);
            assert_json(&result["price"], json!(30));
            let expected = result["price"].as_f64().unwrap() * result["quantity"].as_f64().unwrap();
            assert_close(&result["amount"], expected, 2);
        }
    }

    // The dropdown offers six types and this rule speaks for two. A caller
    // handing it one of the other four gets a sale, which is why the caller
    // has to ask `moves_shares` first rather than this silently coping.
    #[test]
    fn only_a_purchase_and_a_sale_are_types_this_rule_can_speak_for() {
        let covered: Vec<&str> = TYPES.into_iter().filter(|kind| moves_shares(Some(&json!(kind)))).collect();
        assert_eq!(covered, SHARE_TYPES);
        assert_eq!(TYPES.into_iter().filter(|kind| !moves_shares(Some(&json!(kind)))).count(), 4);
        assert!(!moves_shares(None) && !moves_shares(Some(&Json::Null)) && !moves_shares(Some(&json!(1))));
    }

    // A price edit must not move direction. Both readings agree on an already
    // canonical row, so the fixture has to start uncanonical to see it.
    #[test]
    fn a_price_edit_keeps_the_direction_the_quantity_already_had() {
        let result = normalize_share_movement(&row(SELL, 5.0, 30.0, -150.0), IntentField::Price);
        assert_json(&result["type"], json!("buy"));
        assert_json(&result["quantity"], json!(5));
    }

    #[test]
    fn only_a_hand_entered_purchase_or_sale_is_rewritten() {
        assert!(is_normalizable_row(Some("manual"), &json!({ "type": "buy" })));
        assert!(is_normalizable_row(Some("manual"), &json!({ "type": "sell" })));
    }

    // One provider mints every movement as a `buy` of one unit priced at the
    // whole amount, signed positive when the money arrives. Rewriting those
    // would turn its withdrawals into deposits.
    #[test]
    fn never_a_provider_row_whatever_shape_it_is_in() {
        for source in [Some("plaid"), Some("simple_fin"), None] {
            assert!(!is_normalizable_row(source, &json!({ "type": "buy" })));
            assert!(!is_normalizable_row(source, &json!({ "type": "sell" })));
        }
    }

    // A fee or a cash movement carries its value somewhere `price * quantity`
    // cannot express, so there is nothing here to make consistent.
    #[test]
    fn never_a_manual_row_that_moves_no_shares() {
        for kind in ["cash", "fee", "transfer", "cancel"] {
            assert!(!is_normalizable_row(Some("manual"), &json!({ "type": kind })));
        }
    }

    // The editor's whole decision, reachable without rendering it. The gate here
    // is what keeps a picked type from being replaced by a sale.
    fn canonical_buy() -> Json {
        row(BUY, 5.0, 30.0, 150.0)
    }

    fn fee_row() -> Json {
        row("fee", 1.0, 25.0, 25.0)
    }

    #[test]
    fn picking_a_type_that_moves_no_shares_stores_that_type_not_a_sale() {
        for kind in TYPES.into_iter().filter(|kind| !moves_shares(Some(&json!(kind)))) {
            let patch = shape_patch_for(Some("manual"), &canonical_buy(), IntentField::Type, &json!({ "type": kind }));
            assert_json(&patch, json!({ "type": kind }));
        }
    }

    #[test]
    fn editing_a_number_on_a_row_that_moves_no_shares_leaves_its_type_alone() {
        let patch = shape_patch_for(Some("manual"), &fee_row(), IntentField::Price, &json!({ "price": 40 }));
        assert_json(&patch, json!({ "price": 40, "amount": 40 }));
    }

    // A row that moves no shares still derives its amount, which is what keeps
    // it out of the transaction list's zero-amount filter.
    #[test]
    fn a_quantity_edit_on_a_row_that_moves_no_shares_still_derives_the_amount() {
        let patch = shape_patch_for(Some("manual"), &fee_row(), IntentField::Quantity, &json!({ "quantity": 2 }));
        assert_json(&patch, json!({ "quantity": 2, "amount": 50 }));
    }

    // One provider signs a movement positive when the money arrives, so
    // reconciling its rows would turn withdrawals into deposits.
    #[test]
    fn a_provider_row_is_never_reconciled_whatever_shape_it_is_in() {
        for source in [Some("plaid"), Some("simple_fin"), None] {
            let patch = shape_patch_for(source, &canonical_buy(), IntentField::Type, &json!({ "type": "sell" }));
            assert_json(&patch, json!({ "type": "sell" }));
        }
    }

    #[test]
    fn picking_sell_corrects_the_quantity_and_the_amount_with_it() {
        let patch = shape_patch_for(Some("manual"), &canonical_buy(), IntentField::Type, &json!({ "type": "sell" }));
        assert_json(&patch, json!({ "type": "sell", "quantity": -5, "amount": -150 }));
    }

    #[test]
    fn a_negative_quantity_is_stored_as_a_sale() {
        let patch = shape_patch_for(Some("manual"), &canonical_buy(), IntentField::Quantity, &json!({ "quantity": -4 }));
        assert_json(&patch, json!({ "type": "sell", "quantity": -4, "amount": -120 }));
    }

    #[test]
    fn a_field_the_edit_agrees_with_is_not_written() {
        let patch = shape_patch_for(Some("manual"), &canonical_buy(), IntentField::Price, &json!({ "price": 40 }));
        assert_json(&patch, json!({ "price": 40, "amount": 200 }));
    }

    #[test]
    fn an_edit_that_changes_nothing_writes_nothing() {
        let patch = shape_patch_for(Some("manual"), &canonical_buy(), IntentField::Price, &json!({ "price": 30 }));
        assert_json(&patch, json!({}));
    }

    #[test]
    fn a_missing_or_null_figure_is_read_as_javascript_reads_it() {
        // `null >= 0` holds and `undefined >= 0` does not; NaN is written as null.
        let null_quantity = json!({ "type": "sell", "quantity": null, "price": 2, "amount": 0 });
        assert_json(&normalize_share_movement(&null_quantity, IntentField::Quantity), json!({ "type": "buy", "quantity": 0, "price": 2, "amount": 0 }));
        let no_quantity = json!({ "type": "buy", "price": 2 });
        assert_json(
            &normalize_share_movement(&no_quantity, IntentField::Quantity),
            json!({ "type": "sell", "quantity": null, "price": 2, "amount": null }),
        );
        // A patch names every field the canonical row disagrees with, a NaN one included.
        let patch = shape_patch_for(Some("manual"), &no_quantity, IntentField::Price, &json!({ "price": 3 }));
        assert_json(&patch, json!({ "quantity": null, "price": 3, "amount": null }));
        assert!(!is_canonical(&no_quantity, None));
        assert!(is_canonical(&json!({ "type": "cash", "quantity": 0, "price": 0, "amount": 0 }), Some(true)));
        assert_eq!(IntentField::parse("price"), Some(IntentField::Price));
        assert_eq!(IntentField::parse("amount"), None);
    }
}
