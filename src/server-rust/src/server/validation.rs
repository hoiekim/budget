//! Request parameter validation, message for message
//! `src/server/lib/validation.ts`.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::{js_length, number_to_string, Json, JsDate, Obj};
use crate::server::route::{ApiResponse, QueryValue, Request};

/// The failure message of a validation.
pub type Validation<T> = Result<T, String>;

/// A required query parameter: present once, not empty.
pub fn require_query_string(req: &Request, param: &str) -> Validation<String> {
    match req.query.get(param) {
        None => Err(format!("Missing required parameter: {param}")),
        // Repeated params (e.g. ?id=a&id=b) are parsed as arrays.
        Some(QueryValue::Many(_)) => Err(format!("Parameter {param} must be a single value, not an array")),
        Some(QueryValue::One(value)) if js_trim(value).is_empty() => Err(format!("Parameter {param} cannot be empty")),
        Some(QueryValue::One(value)) => Ok(value.clone()),
    }
}

/// An optional query parameter; `None` when absent or empty.
pub fn optional_query_string(req: &Request, param: &str) -> Validation<Option<String>> {
    match req.query.get(param) {
        None => Ok(None),
        Some(QueryValue::Many(_)) => Err(format!("Parameter {param} must be a single value, not an array")),
        Some(QueryValue::One(value)) if value.is_empty() => Ok(None),
        Some(QueryValue::One(value)) => Ok(Some(value.clone())),
    }
}

/// The request body as an object.
pub fn require_body_object(req: &Request) -> Validation<&Obj> {
    match &req.body {
        None | Some(Json::Null) => Err("Request body is required".to_string()),
        Some(Json::Object(body)) => Ok(body),
        Some(_) => Err("Request body must be an object".to_string()),
    }
}

pub fn require_string_field(obj: &Obj, field: &str) -> Validation<String> {
    match obj.get(field) {
        None | Some(Json::Null) => Err(format!("Missing required field: {field}")),
        Some(Json::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("Field {field} must be a string")),
    }
}

static TICKER_SYMBOL_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z0-9.:-]{1,16}$").unwrap());

/// `String.prototype.trim` whitespace: Unicode white space plus line
/// terminators and the BOM, without the next-line control (U+0085), which
/// JavaScript does not count.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// A ticker-symbol field, returned trimmed and upper-cased.
pub fn require_ticker_symbol(obj: &Obj, field: &str) -> Validation<String> {
    let value = require_string_field(obj, field)?;
    let normalized = js_trim(&value).to_uppercase();
    if !TICKER_SYMBOL_PATTERN.is_match(&normalized) {
        return Err("Ticker symbol must be 1-16 characters of A-Z, 0-9, '.', '-' or ':'".to_string());
    }
    Ok(normalized)
}

pub fn require_number_field(obj: &Obj, field: &str) -> Validation<f64> {
    match obj.get(field) {
        None | Some(Json::Null) => Err(format!("Missing required field: {field}")),
        Some(Json::Number(n)) => n.as_f64().filter(|f| f.is_finite()).ok_or_else(|| format!("Field {field} must be a number")),
        Some(_) => Err(format!("Field {field} must be a number")),
    }
}

pub use crate::common::date::local_date;

/// An optional caller-supplied date field as a `LocalDate`; absent, null or empty is `None`.
pub fn optional_date_field(obj: &Obj, field: &str, label: Option<&str>) -> Validation<Option<JsDate>> {
    let label = label.unwrap_or(field);
    match obj.get(field) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(value)) if value.is_empty() => Ok(None),
        Some(Json::String(value)) => {
            let date = local_date(value);
            if date.is_valid() {
                Ok(Some(date))
            } else {
                Err(format!("{label} is not a valid date"))
            }
        }
        Some(_) => Err(format!("{label} must be a string")),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Uuid,
    Date,
    Array,
}

impl FieldType {
    fn name(self) -> &'static str {
        match self {
            FieldType::String => "string",
            FieldType::Number => "number",
            FieldType::Boolean => "boolean",
            FieldType::Uuid => "uuid",
            FieldType::Date => "date",
            FieldType::Array => "array",
        }
    }

    fn article(self) -> &'static str {
        if self == FieldType::Array {
            "an"
        } else {
            "a"
        }
    }
}

/// One typed field of a request body.
#[derive(Clone, Copy, Debug)]
pub struct FieldSpec {
    /// Dot path into the body: `"balances.current"`, `"label.budget_id"`.
    pub path: &'static str,
    pub field_type: FieldType,
    /// Absent is an error. Default false: these bodies are partial updates.
    pub required: bool,
    /// Explicit `null` is accepted.
    pub nullable: bool,
    /// Longest string the column takes, in UTF-16 code units as JS counts.
    pub max_length: Option<usize>,
    /// Inclusive lower bound.
    pub min: Option<f64>,
    /// Largest magnitude a number may carry.
    pub max: Option<f64>,
}

impl FieldSpec {
    pub const fn new(path: &'static str, field_type: FieldType) -> Self {
        FieldSpec { path, field_type, required: false, nullable: false, max_length: None, min: None, max: None }
    }
    pub const fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub const fn nullable(mut self) -> Self {
        self.nullable = true;
        self
    }
    pub const fn max_length(mut self, max_length: usize) -> Self {
        self.max_length = Some(max_length);
        self
    }
    pub const fn min(mut self, min: f64) -> Self {
        self.min = Some(min);
        self
    }
    pub const fn max(mut self, max: f64) -> Self {
        self.max = Some(max);
        self
    }
}

/// Largest magnitude a `DECIMAL(15, 2)` column takes.
pub const DECIMAL_15_2_MAX: f64 = 9999999999999.99;
/// Largest magnitude a `DECIMAL(15, 6)` column takes.
pub const DECIMAL_15_6_MAX: f64 = 999999999.999999;

static UUID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());

/// Whether a value is a well-formed UUID string.
pub fn is_uuid(value: &Json) -> bool {
    value.as_str().map(is_uuid_str).unwrap_or(false)
}

pub fn is_uuid_str(value: &str) -> bool {
    UUID_RE.is_match(value)
}

// `.` does not match line terminators in a JS regex without the `s` flag.
static DATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ][^\n\r\u{2028}\u{2029}]*)?$").unwrap());

fn is_date_string(value: &Json) -> bool {
    let Some(text) = value.as_str() else { return false };
    let Some(captures) = DATE_RE.captures(text) else { return false };
    let part = |i: usize| captures[i].parse::<i64>().unwrap_or(0);
    let (year, month, day) = (part(1), part(2), part(3));
    let parsed = JsDate::from_utc(year, month - 1, day, 0, 0, 0, 0);
    parsed.get_utc_full_year() == year
        && parsed.get_utc_month() == month - 1
        && parsed.get_utc_date() == day
        && JsDate::parse(text).is_valid()
}

fn finite_number(value: &Json) -> Option<f64> {
    value.as_f64().filter(|f| f.is_finite())
}

fn matches_type(value: &Json, spec: &FieldSpec) -> bool {
    match spec.field_type {
        FieldType::String => match value {
            Json::String(s) => spec.max_length.map(|max| js_length(s) <= max).unwrap_or(true),
            _ => false,
        },
        FieldType::Number => match finite_number(value) {
            Some(n) => spec.max.map(|max| n.abs() <= max).unwrap_or(true),
            None => false,
        },
        FieldType::Boolean => value.is_boolean(),
        FieldType::Uuid => is_uuid(value),
        FieldType::Date => is_date_string(value),
        FieldType::Array => value.is_array(),
    }
}

fn exceeds_bound(value: &Json, spec: &FieldSpec) -> bool {
    match (spec.field_type, spec.max_length, spec.max) {
        (FieldType::String, Some(max), _) => value.as_str().map(|s| js_length(s) > max).unwrap_or(false),
        (FieldType::Number, _, Some(max)) => finite_number(value).map(|n| n.abs() > max).unwrap_or(false),
        _ => false,
    }
}

fn type_error(spec: &FieldSpec) -> String {
    format!("Field {} must be {} {}", spec.path, spec.field_type.article(), spec.field_type.name())
}

fn bound_error(spec: &FieldSpec) -> String {
    match (spec.field_type, spec.max_length, spec.max) {
        (FieldType::String, Some(max), _) => format!("Field {} must be at most {} characters", spec.path, max),
        (FieldType::Number, _, Some(max)) => format!("Field {} must be at most {}", spec.path, number_to_string(max)),
        _ => type_error(spec),
    }
}

/// Checks a body's typed fields before any of them reach SQL, returning the
/// first failure. Missing optional fields are skipped.
pub fn validate_fields(obj: &Obj, specs: &[FieldSpec]) -> Validation<()> {
    let root = Json::Object(obj.clone());
    for spec in specs {
        let mut segments: Vec<&str> = spec.path.split('.').collect();
        let leaf = segments.pop().unwrap_or(spec.path);

        // `container` is `None` for undefined.
        let mut container: Option<&Json> = Some(&root);
        for (i, segment) in segments.iter().enumerate() {
            match container {
                None | Some(Json::Null) => break,
                Some(Json::Object(map)) => container = map.get(*segment),
                Some(_) => {
                    let named = if i == 0 { spec.path } else { segments[i - 1] };
                    return Err(format!("Field {named} must be an object"));
                }
            }
        }

        let map = match container {
            None | Some(Json::Null) => {
                if spec.required {
                    return Err(format!("Missing required field: {}", spec.path));
                }
                continue;
            }
            Some(Json::Object(map)) => map,
            Some(_) => {
                let named = segments.last().copied().unwrap_or(spec.path);
                return Err(format!("Field {named} must be an object"));
            }
        };

        let value = match map.get(leaf) {
            None => {
                if spec.required {
                    return Err(format!("Missing required field: {}", spec.path));
                }
                continue;
            }
            Some(Json::Null) => {
                if spec.nullable {
                    continue;
                }
                return Err(type_error(spec));
            }
            Some(value) => value,
        };

        if !matches_type(value, spec) {
            return Err(if exceeds_bound(value, spec) { bound_error(spec) } else { type_error(spec) });
        }
        if spec.field_type == FieldType::Number {
            let number = value.as_f64().unwrap_or(0.0);
            if let Some(min) = spec.min {
                if number < min {
                    return Err(format!("Field {} must be at least {}", spec.path, number_to_string(min)));
                }
            }
            if let Some(max) = spec.max {
                if number > max {
                    return Err(format!("Field {} must be at most {}", spec.path, number_to_string(max)));
                }
            }
        }
    }
    Ok(())
}

/// A failed API response carrying a validation message.
pub fn validation_error(message: impl Into<String>) -> ApiResponse {
    ApiResponse::failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: Json) -> Obj {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn names_the_parent_that_is_not_an_object() {
        let specs = [FieldSpec::new("balances.current", FieldType::Number)];
        assert_eq!(validate_fields(&obj(json!({ "balances": 5 })), &specs), Err("Field balances must be an object".into()));
        assert_eq!(validate_fields(&obj(json!({ "balances": null })), &specs), Ok(()));
        assert_eq!(validate_fields(&obj(json!({})), &specs), Ok(()));
        assert_eq!(
            validate_fields(&obj(json!({ "balances": { "current": "x" } })), &specs),
            Err("Field balances.current must be a number".into())
        );
    }

    #[test]
    fn bounds_get_their_own_message() {
        let specs = [
            FieldSpec::new("name", FieldType::String).max_length(3),
            FieldSpec::new("amount", FieldType::Number).max(DECIMAL_15_2_MAX),
        ];
        assert_eq!(validate_fields(&obj(json!({ "name": "abcd" })), &specs), Err("Field name must be at most 3 characters".into()));
        assert_eq!(
            validate_fields(&obj(json!({ "amount": 1e13 })), &specs),
            Err("Field amount must be at most 9999999999999.99".into())
        );
    }

    #[test]
    fn dates_must_exist_on_the_calendar() {
        let specs = [FieldSpec::new("date", FieldType::Date)];
        assert_eq!(validate_fields(&obj(json!({ "date": "2026-02-28T00:00:00" })), &specs), Ok(()));
        assert_eq!(validate_fields(&obj(json!({ "date": "2026-02-30" })), &specs), Err("Field date must be a date".into()));
        assert_eq!(validate_fields(&obj(json!({ "date": "2026-02-03Tjunk" })), &specs), Err("Field date must be a date".into()));
    }
}
