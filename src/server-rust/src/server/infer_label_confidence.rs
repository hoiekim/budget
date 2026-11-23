//! `src/server/lib/infer-label-confidence.ts`.

use crate::js::{num, truthy, Json, Obj};

/// Lifts user intent from a label update into `category_confidence` when the
/// caller didn't set it explicitly:
///
/// - no `label`, or no `category_id` in it: untouched;
/// - `category_id` set, confidence absent: 1 (the user chose a category);
/// - `category_id: null`, confidence absent: 0 (the user cleared it, which
///   counts as a rejection so auto-suggest doesn't suggest the same again);
/// - confidence given: kept.
///
/// Owned by the route boundary: handlers call this before passing the body
/// to a repository. A `label` that is truthy but not an object is an error,
/// as the `in` operator throws on one.
pub fn infer_label_confidence(input: &Obj) -> anyhow::Result<Obj> {
    let label = match input.get("label") {
        Some(label) if truthy(label) => label,
        _ => return Ok(input.clone()),
    };
    let label = match label {
        Json::Object(label) => label,
        Json::Array(_) => return Ok(input.clone()),
        _ => anyhow::bail!("Cannot use 'in' operator to search for 'category_id' in a non-object label"),
    };
    let Some(category_id) = label.get("category_id") else { return Ok(input.clone()) };
    if label.contains_key("category_confidence") {
        return Ok(input.clone());
    }
    let mut label = label.clone();
    label.insert("category_confidence".into(), num(if category_id.is_null() { 0.0 } else { 1.0 }));
    let mut output = input.clone();
    output.insert("label".into(), Json::Object(label));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn infer(value: Json) -> Json {
        Json::Object(infer_label_confidence(value.as_object().unwrap()).unwrap())
    }

    #[test]
    fn a_chosen_category_is_confirmed_and_a_cleared_one_rejected() {
        assert_eq!(infer(json!({ "label": { "category_id": "c" } })), json!({ "label": { "category_id": "c", "category_confidence": 1 } }));
        assert_eq!(infer(json!({ "label": { "category_id": null } })), json!({ "label": { "category_id": null, "category_confidence": 0 } }));
    }

    #[test]
    fn everything_else_is_left_alone() {
        for input in [
            json!({}),
            json!({ "label": null }),
            json!({ "label": {} }),
            json!({ "label": { "memo": "m" } }),
            json!({ "label": { "category_id": "c", "category_confidence": 0.4 } }),
            json!({ "label": { "category_id": null, "category_confidence": null } }),
            json!({ "label": [] }),
        ] {
            assert_eq!(infer(input.clone()), input);
        }
        assert!(infer_label_confidence(json!({ "label": "text" }).as_object().unwrap()).is_err());
    }
}
