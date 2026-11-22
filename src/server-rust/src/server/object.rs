//! `src/server/lib/object.ts`.

use indexmap::IndexMap;

use crate::js::{truthy, Json, Obj};

/// Flattens nested objects into dotted paths: `{ a: { b: 1 } }` becomes
/// `{ "a.b": 1 }`. Scalars and arrays are kept; a path seen twice collects
/// its values into an array.
pub fn flatten(obj: &Obj) -> IndexMap<String, Json> {
    let mut queue: Vec<(String, Json)> = obj.iter().map(|(key, value)| (key.clone(), value.clone())).collect();
    let mut map: IndexMap<String, Json> = IndexMap::new();
    let mut index = 0;
    while index < queue.len() {
        let (address, value) = queue[index].clone();
        index += 1;
        if let Json::Object(nested) = &value {
            for (key, inner) in nested {
                queue.push((format!("{address}.{key}"), inner.clone()));
            }
            continue;
        }
        match map.get_mut(&address) {
            // A falsy existing value is overwritten, as the TypeScript's `if (existingData)` does.
            Some(existing) if truthy(existing) => match existing {
                Json::Array(items) => items.push(value),
                _ => {
                    let previous = existing.take();
                    *existing = Json::Array(vec![previous, value]);
                }
            },
            _ => {
                map.insert(address, value);
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flattens_nested_objects() {
        let flat = flatten(json!({ "a": 1, "b": { "c": "x", "d": { "e": null } }, "f": [1, 2] }).as_object().unwrap());
        let flat: Obj = flat.into_iter().collect();
        assert_eq!(Json::Object(flat), json!({ "a": 1, "f": [1, 2], "b.c": "x", "b.d.e": null }));
    }
}
