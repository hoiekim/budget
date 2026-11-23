//! Object literals and property reads the way the models' TypeScript writes
//! them. `None` is `undefined` throughout: reading a key an object lacks
//! gives it, and a property written with it is left out, which is what
//! `JSON.stringify` and the query builders both make of an `undefined`
//! property.

use crate::js::{to_js_string, truthy, Json, Obj};

/// An object literal being written. Keys keep the order they are given in;
/// a key given twice keeps its first place and takes its last value, as an
/// assignment to a JS object does.
///
/// The members are gathered first and made into one object of the right
/// size at the end: the models build one of these per row of a list.
#[derive(Default)]
pub(super) struct Literal(Vec<(String, Json)>);

impl Literal {
    pub(super) fn new() -> Self {
        Literal::default()
    }

    /// `key: value` for a value that is never `undefined`.
    pub(super) fn set(mut self, key: &str, value: impl Into<Json>) -> Self {
        self.0.push((key.to_string(), value.into()));
        self
    }

    /// `key: value` for a value that may be `undefined`; equally
    /// `if (value !== undefined) object[key] = value`.
    pub(super) fn opt(mut self, key: &str, value: Option<&Json>) -> Self {
        if let Some(value) = value {
            self.0.push((key.to_string(), value.clone()));
        }
        self
    }

    pub(super) fn into_obj(self) -> Obj {
        let mut object = Obj::with_capacity(self.0.len());
        for (key, value) in self.0 {
            object.insert(key, value);
        }
        object
    }
}

impl From<Literal> for Json {
    fn from(literal: Literal) -> Json {
        Json::Object(literal.into_obj())
    }
}

/// `value` where it is truthy, `undefined` otherwise: `value || undefined`,
/// and the object a guard such as `if (tx.label)` lets through.
pub(super) fn truthy_only(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| truthy(value))
}

/// `a || b`.
pub(super) fn or<'a>(a: Option<&'a Json>, b: Option<&'a Json>) -> Option<&'a Json> {
    truthy_only(a).or(b)
}

/// `value ?? fallback`.
pub(super) fn nullish_or(value: Option<&Json>, fallback: impl Into<Json>) -> Json {
    match value {
        None | Some(Json::Null) => fallback.into(),
        Some(value) => value.clone(),
    }
}

/// `object?.key`, and `object.key` behind a guard that `object` is truthy.
/// A primitive has none of the properties the models read, so it gives
/// `undefined` as a missing key does.
pub(super) fn prop<'a>(object: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    object.and_then(|object| object.get(key))
}

/// `` `${value}` ``.
pub(super) fn interpolate(value: Option<&Json>) -> String {
    value.map(to_js_string).unwrap_or_else(|| "undefined".to_string())
}

/// `const { a, b, ...rest } = object`: `object` without the keys taken out of it.
pub(super) fn rest(object: &Obj, taken: &[&str]) -> Obj {
    object.iter().filter(|(key, _)| !taken.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect()
}

/// The number a key is when it is an array index (`"0"`, `"17"`), which is
/// what makes an object list it ahead of its other keys.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `Object.entries(value)` for an object or an array; nothing else gets past
/// the row checks to where the models call it. An object gives its array-index
/// keys first, in ascending order, then the rest as written.
pub(super) fn entries(value: &Json) -> Vec<(String, &Json)> {
    match value {
        Json::Object(map) => {
            let mut indexed: Vec<(u32, &String, &Json)> =
                map.iter().filter_map(|(key, value)| array_index(key).map(|index| (index, key, value))).collect();
            indexed.sort_by_key(|(index, _, _)| *index);
            let named = map.iter().filter(|(key, _)| array_index(key).is_none());
            indexed.into_iter().map(|(_, key, value)| (key.clone(), value)).chain(named.map(|(key, value)| (key.clone(), value))).collect()
        }
        Json::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
        _ => Vec::new(),
    }
}

/// What the models' tests share.
#[cfg(test)]
pub(super) mod testing {
    use crate::js::{json_stringify, Json, Obj};

    /// The object a `json!` literal wrote.
    pub fn obj(value: Json) -> Obj {
        match value {
            Json::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    /// Asserts `actual` is `expected` key for key *in the same order*, which
    /// comparing two `Json` values with `==` does not check.
    #[track_caller]
    pub fn assert_json(actual: &Json, expected: Json) {
        assert_eq!(json_stringify(actual), json_stringify(&expected));
    }

    /// [`assert_json`] for a row a `from_json` built.
    #[track_caller]
    pub fn assert_row(actual: &Obj, expected: Json) {
        assert_json(&Json::Object(actual.clone()), expected);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::testing::{assert_json, obj};
    use super::*;

    #[test]
    fn a_literal_leaves_undefined_out_and_keeps_null() {
        let source = obj(json!({ "a": null, "c": 0 }));
        let literal = Literal::new().opt("a", source.get("a")).opt("b", source.get("b")).set("d", "x").opt("c", source.get("c"));
        assert_json(&literal.into(), json!({ "a": null, "d": "x", "c": 0 }));
    }

    #[test]
    fn assigning_a_key_again_keeps_its_first_position() {
        let literal = Literal::new().set("a", 1).set("b", 2).set("a", 3);
        assert_json(&literal.into(), json!({ "a": 3, "b": 2 }));
    }

    #[test]
    fn or_falls_through_every_falsy_value_and_nullish_only_through_two() {
        let (empty, zero, no, null, text) = (json!(""), json!(0), json!(false), Json::Null, json!("x"));
        for falsy in [&empty, &zero, &no, &null] {
            assert_eq!(truthy_only(Some(falsy)), None);
            assert_eq!(or(Some(falsy), Some(&text)), Some(&text));
        }
        assert_eq!(or(None, Some(&null)), Some(&null));
        assert_eq!(or(Some(&text), None), Some(&text));
        assert_eq!(or(Some(&empty), None), None);

        assert_eq!(nullish_or(Some(&empty), "fallback"), json!(""));
        assert_eq!(nullish_or(Some(&zero), 5), json!(0));
        assert_eq!(nullish_or(Some(&no), true), json!(false));
        assert_eq!(nullish_or(Some(&null), "fallback"), json!("fallback"));
        assert_eq!(nullish_or(None, "fallback"), json!("fallback"));
    }

    #[test]
    fn a_property_of_anything_but_an_object_is_undefined() {
        let holder = json!({ "label": { "memo": null }, "text": "abc", "list": [1], "none": null });
        assert_eq!(prop(holder.get("label"), "memo"), Some(&Json::Null));
        assert_eq!(prop(holder.get("label"), "budget_id"), None);
        assert_eq!(prop(holder.get("text"), "memo"), None);
        assert_eq!(prop(holder.get("list"), "memo"), None);
        assert_eq!(prop(holder.get("none"), "memo"), None);
        assert_eq!(prop(holder.get("missing"), "memo"), None);
    }

    #[test]
    fn interpolates_like_a_template_literal() {
        assert_eq!(interpolate(None), "undefined");
        assert_eq!(interpolate(Some(&Json::Null)), "null");
        assert_eq!(interpolate(Some(&json!("acc"))), "acc");
        assert_eq!(interpolate(Some(&json!(1.5))), "1.5");
    }

    #[test]
    fn rest_keeps_the_remaining_keys_in_order() {
        let object = obj(json!({ "a": 1, "label": {}, "b": 2, "source": "x", "c": 3 }));
        assert_json(&Json::Object(rest(&object, &["label", "source", "absent"])), json!({ "a": 1, "b": 2, "c": 3 }));
    }

    #[test]
    fn entries_list_array_index_keys_first() {
        let value = json!({ "b": 1, "10": 2, "a": 3, "9": 4, "01": 5, "-1": 6, "4294967295": 7, "0": 8 });
        let keys: Vec<String> = entries(&value).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, ["0", "9", "10", "b", "a", "01", "-1", "4294967295"]);

        let list = json!(["x", "y"]);
        assert_eq!(entries(&list), vec![("0".to_string(), &json!("x")), ("1".to_string(), &json!("y"))]);
        assert!(entries(&json!("text")).is_empty());
    }
}
