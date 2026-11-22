//! JavaScript value semantics the TypeScript backend leans on, reproduced so
//! the two servers agree on edge cases: truthiness, `typeof`, number
//! formatting, `Date` parsing and local-time arithmetic, URI encoding.
//!
//! Request bodies, database rows and responses are all `serde_json::Value`
//! (`Json`) here, with object keys in insertion order, the way the TypeScript
//! code holds them as plain objects. An absent key stands for `undefined`.

use chrono::{DateTime, Datelike, LocalResult, NaiveDateTime, Offset, TimeZone, Timelike, Utc};
use serde_json::Number;

pub type Json = serde_json::Value;
pub type Obj = serde_json::Map<String, Json>;

/// `2^53`: integers up to here survive a round trip through a JS number.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A JS number as JSON: integral values print without a fraction, as
/// `JSON.stringify` does; `NaN` and the infinities become `null`.
pub fn num(value: f64) -> Json {
    if !value.is_finite() {
        return Json::Null;
    }
    // Integral doubles below 2^63 convert to `i64` exactly, including those
    // past 2^53 that are no longer "safe" but are still whole numbers.
    if value.fract() == 0.0 && value.abs() < 9.0e18 && !(value == 0.0 && value.is_sign_negative()) {
        return Json::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map(Json::Number).unwrap_or(Json::Null)
}

/// Rewrites every number in `value` the way `JSON.parse` would hold it: one
/// double. An integer past 2^53 loses its low bits here exactly as it does in
/// JS, so both servers compare, store and echo the same value.
pub fn normalize_numbers(value: &mut Json) {
    match value {
        Json::Number(n) => {
            if let Some(f) = n.as_f64() {
                *value = num(f);
            }
        }
        Json::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Json::Object(map) => map.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// The number a property key is when it is an array index (`"0"`, `"17"`).
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// Puts the keys of every object in `value` in the order a JS object lists
/// them, and so the order `JSON.stringify` writes them back in: array-index
/// keys first, ascending, then the rest as written.
fn normalize_key_order(value: &mut Json) {
    match value {
        Json::Array(items) => items.iter_mut().for_each(normalize_key_order),
        Json::Object(map) => {
            map.values_mut().for_each(normalize_key_order);
            if map.keys().any(|key| array_index(key).is_some()) {
                let mut indexed = Vec::new();
                let mut named = Vec::new();
                for (key, member) in std::mem::take(map) {
                    match array_index(&key) {
                        Some(index) => indexed.push((index, key, member)),
                        None => named.push((key, member)),
                    }
                }
                indexed.sort_by_key(|(index, _, _)| *index);
                map.extend(indexed.into_iter().map(|(_, key, member)| (key, member)).chain(named));
            }
        }
        _ => {}
    }
}

/// `JSON.parse`, or `None` where it would throw.
pub fn json_parse(text: &str) -> Option<Json> {
    let mut value: Json = serde_json::from_str(text).ok()?;
    normalize_numbers(&mut value);
    normalize_key_order(&mut value);
    Some(value)
}

fn write_json(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // The digits `Number.prototype.toString` writes, so text that is
        // stored or hashed is the same on both servers.
        Json::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => out.push_str(&number_to_string(f)),
            _ => out.push_str("null"),
        },
        Json::String(text) => out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())),
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Json::Object(map) => {
            out.push('{');
            for (index, (key, member)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                write_json(member, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` for a value that is already JSON, numbers included:
/// `1.5e-6` prints as `0.0000015` and negative zero as `0`.
pub fn json_stringify(value: &Json) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

/// JS truthiness of a JSON value; an absent value (`undefined`) is falsy.
pub fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Json::String(s) => !s.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}

pub fn truthy_opt(value: Option<&Json>) -> bool {
    value.map(truthy).unwrap_or(false)
}

/// `typeof value`, with `None` for `undefined`.
pub fn type_of(value: Option<&Json>) -> &'static str {
    match value {
        None => "undefined",
        Some(Json::Null) | Some(Json::Array(_)) | Some(Json::Object(_)) => "object",
        Some(Json::Bool(_)) => "boolean",
        Some(Json::Number(_)) => "number",
        Some(Json::String(_)) => "string",
    }
}

/// `String(n)` for a JS number.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if value == 0.0 {
        return "0".to_string();
    }
    // `Number::toString`: the digits `s` and the exponent `n` with `value = 0.s × 10^n`.
    let (digits, n) = shortest_digits(value.abs());
    let k = digits.len() as i32;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push_str(&format!("e{}{}", if n > 0 { "+" } else { "-" }, (n - 1).abs()));
    }
    out
}

/// The fewest significant digits that read back as `value` (positive and
/// finite), and the exponent `n` with `value = 0.digits × 10^n`. Of two
/// candidates equally close to `value`, JavaScript takes the even one where
/// Rust's shortest formatting rounds up (`900719925474099.25` is
/// `900719925474099.2`, not `.3`).
fn shortest_digits(value: f64) -> (String, i32) {
    let formatted = format!("{value:e}");
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let last = digits.as_bytes()[digits.len() - 1];
    if digits.len() > 1 && (last - b'0') % 2 == 1 {
        // The even neighbour, one unit lower in the last digit: a tie when it reads back as `value` too
        // and `value` lies exactly halfway, its exact expansion being the neighbour's digits and a 5.
        let mut lower = digits.clone();
        lower.pop();
        lower.push((last - 1) as char);
        let reads_back = format!("{}.{}e{exponent}", &lower[..1], &lower[1..]).parse::<f64>().ok() == Some(value);
        if reads_back {
            // A double's exact decimal expansion has at most 767 significant digits.
            let exact = format!("{value:.800e}");
            let (exact_mantissa, exact_exponent) = exact.split_once('e').unwrap_or((&exact, "0"));
            let exact_digits: String = exact_mantissa.chars().filter(|c| *c != '.').collect();
            let halfway = exact_exponent.parse::<i32>().ok() == Some(exponent)
                && exact_digits.starts_with(&lower)
                && exact_digits[lower.len()..].starts_with('5')
                && exact_digits[lower.len() + 1..].bytes().all(|b| b == b'0');
            if halfway {
                digits = lower;
            }
        }
    }
    (digits, exponent + 1)
}

/// `String(value)` for any JSON value.
pub fn to_js_string(value: &Json) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => s.clone(),
        Json::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Json::Object(_) => "[object Object]".to_string(),
    }
}

/// `Math.round`: halves round toward positive infinity, and a value in
/// `[-0.5, -0]` rounds to negative zero. Not `floor(value + 0.5)`, whose sum
/// itself rounds up just under a half (0.49999999999999994) and on odd
/// integers past 2^52.
pub fn math_round(value: f64) -> f64 {
    if value.is_sign_negative() && value >= -0.5 {
        return -0.0;
    }
    let floor = value.floor();
    // Exact: below 2^52 the fraction is a multiple of the value's own unit, and past it there is none.
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number.prototype.toFixed`: the nearest decimal, a tie going to the larger
/// magnitude. Rust's own formatting rounds ties to even, which differs on
/// values that are exactly representable (`0.125`, `2.5`).
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return number_to_string(value);
    }
    if value.abs() >= 1e21 {
        return number_to_string(value);
    }
    let negative = value < 0.0;
    // The exact decimal expansion of a double has at most 1074 fraction digits.
    let exact = format!("{:.1100}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_out: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = fraction.as_bytes().get(digits).map(|b| *b >= b'5').unwrap_or(false);
    if round_up {
        let mut i = digits_out.len();
        loop {
            if i == 0 {
                digits_out.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_out[i] == 9 {
                digits_out[i] = 0;
            } else {
                digits_out[i] += 1;
                break;
            }
        }
    }
    let whole_len = digits_out.len() - digits;
    let mut out = String::new();
    // The sign stays on a negative number that rounds to zero: `(-0.001).toFixed(2)` is `-0.00`.
    if negative {
        out.push('-');
    }
    for (i, digit) in digits_out.iter().enumerate() {
        if i == whole_len && digits > 0 {
            out.push('.');
        }
        out.push((b'0' + digit) as char);
    }
    out
}

/// `parseFloat`: the longest numeric prefix, or NaN.
pub fn parse_float(text: &str) -> f64 {
    let trimmed = text.trim_start();
    let bytes = trimmed.as_bytes();
    let mut end = 0;
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    if trimmed[i..].starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let mut seen_digit = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        seen_digit = true;
        end = i;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            seen_digit = true;
            end = i;
        }
    }
    if !seen_digit {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let exponent_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > exponent_start {
            end = j;
        }
    }
    trimmed[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseInt(text, 10)`: the longest integer prefix, or `None` for NaN.
pub fn parse_int(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    trimmed[..i].parse::<f64>().ok()
}

/// `Number(text)` for a string: the whole string must be a number; empty is 0.
pub fn to_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).map(|n| n as f64).unwrap_or(f64::NAN);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = trimmed
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

const URI_COMPONENT_UNRESERVED: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, URI_COMPONENT_UNRESERVED).to_string()
}

/// `decodeURIComponent`, or `None` where it would throw a `URIError`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The number of UTF-16 code units, which is what a JS string's `length` counts.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` by UTF-16 code units, never splitting a character Rust can't hold.
pub fn js_slice_start(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const MS_PER_DAY: f64 = 86_400_000.0;
const MAX_TIME: f64 = 8.64e15;

/// A JS `Date`: milliseconds since the epoch, NaN when invalid. Local-time
/// methods follow the process time zone (`TZ`), as they do in the Bun server.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct JsDate(pub f64);

fn days_from_civil(year: i64, month0: i64, day: i64) -> f64 {
    // month0 may be outside 0..11; normalize like MakeDay.
    let year = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as f64 + (day - 1) as f64
}

fn make_time(hour: f64, minute: f64, second: f64, ms: f64) -> f64 {
    hour * 3_600_000.0 + minute * 60_000.0 + second * 1000.0 + ms
}

fn time_clip(ms: f64) -> f64 {
    if !ms.is_finite() || ms.abs() > MAX_TIME {
        f64::NAN
    } else {
        ms.trunc() + 0.0
    }
}

/// The epoch milliseconds of a local wall-clock time. A time that does not
/// exist (clocks moved forward) takes the offset from before the gap, and one
/// that happens twice takes its first occurrence, as JS does.
fn local_to_utc_ms(local_ms: f64) -> f64 {
    if !local_ms.is_finite() {
        return f64::NAN;
    }
    let seconds = (local_ms / 1000.0).floor();
    let millis = local_ms - seconds * 1000.0;
    let Some(naive) = DateTime::from_timestamp(seconds as i64, 0).map(|dt| dt.naive_utc()) else {
        return f64::NAN;
    };
    let resolved = match chrono::Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt.timestamp(),
        LocalResult::Ambiguous(first, _) => first.timestamp(),
        LocalResult::None => {
            let before = naive - chrono::Duration::hours(3);
            let offset = match chrono::Local.from_local_datetime(&before) {
                LocalResult::Single(dt) => dt.offset().fix().local_minus_utc(),
                LocalResult::Ambiguous(first, _) => first.offset().fix().local_minus_utc(),
                LocalResult::None => 0,
            };
            naive.and_utc().timestamp() - offset as i64
        }
    };
    resolved as f64 * 1000.0 + millis
}

struct Fields {
    year: i64,
    /// 0-11
    month: i64,
    day: i64,
    /// 0 = Sunday
    weekday: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
}

fn fields_of(naive: NaiveDateTime, ms: i64) -> Fields {
    Fields {
        year: naive.year() as i64,
        month: naive.month0() as i64,
        day: naive.day() as i64,
        weekday: naive.weekday().num_days_from_sunday() as i64,
        hour: naive.hour() as i64,
        minute: naive.minute() as i64,
        second: naive.second() as i64,
        ms,
    }
}

impl JsDate {
    pub const INVALID: JsDate = JsDate(f64::NAN);

    /// `new Date()`.
    pub fn now() -> JsDate {
        JsDate(Utc::now().timestamp_millis() as f64)
    }

    /// `Date.now()`.
    pub fn now_ms() -> f64 {
        Utc::now().timestamp_millis() as f64
    }

    /// `new Date(ms)`.
    pub fn from_ms(ms: f64) -> JsDate {
        JsDate(time_clip(ms))
    }

    /// `new Date(text)`.
    pub fn parse(text: &str) -> JsDate {
        JsDate(date_parse(text))
    }

    /// `new Date(value)` for a JSON value: a string is parsed, a number is milliseconds.
    pub fn from_json(value: &Json) -> JsDate {
        match value {
            Json::String(s) => JsDate::parse(s),
            Json::Number(n) => JsDate::from_ms(n.as_f64().unwrap_or(f64::NAN)),
            Json::Null => JsDate(0.0),
            Json::Bool(b) => JsDate(if *b { 1.0 } else { 0.0 }),
            _ => JsDate::INVALID,
        }
    }

    /// `new Date(year, month, day, hour, minute, second, ms)` in local time; `month` is 0-based and any field may overflow.
    pub fn from_local(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> JsDate {
        let local = days_from_civil(year, month, day) * MS_PER_DAY
            + make_time(hour as f64, minute as f64, second as f64, ms as f64);
        JsDate(time_clip(local_to_utc_ms(local)))
    }

    /// `new Date(year, month, day)` in local time.
    pub fn from_local_ymd(year: i64, month: i64, day: i64) -> JsDate {
        JsDate::from_local(year, month, day, 0, 0, 0, 0)
    }

    /// `new Date(Date.UTC(year, month, day, …))`. A year from 0 to 99 is 1900 to 1999, as `Date.UTC` reads it.
    pub fn from_utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> JsDate {
        let year = if (0..=99).contains(&year) { 1900 + year } else { year };
        JsDate(time_clip(
            days_from_civil(year, month, day) * MS_PER_DAY + make_time(hour as f64, minute as f64, second as f64, ms as f64),
        ))
    }

    pub fn is_valid(&self) -> bool {
        !self.0.is_nan()
    }

    /// `getTime()` / `valueOf()`.
    pub fn get_time(&self) -> f64 {
        self.0
    }

    fn utc_naive(&self) -> Option<(NaiveDateTime, i64)> {
        if self.0.is_nan() {
            return None;
        }
        let seconds = (self.0 / 1000.0).floor();
        let ms = (self.0 - seconds * 1000.0) as i64;
        DateTime::from_timestamp(seconds as i64, 0).map(|dt| (dt.naive_utc(), ms))
    }

    fn utc_fields(&self) -> Option<Fields> {
        self.utc_naive().map(|(naive, ms)| fields_of(naive, ms))
    }

    fn local_fields(&self) -> Option<Fields> {
        let (naive, ms) = self.utc_naive()?;
        let local = chrono::Local.from_utc_datetime(&naive).naive_local();
        Some(fields_of(local, ms))
    }

    /// Minutes to add to local time to get UTC, as `getTimezoneOffset()` reports.
    pub fn get_timezone_offset(&self) -> f64 {
        match self.utc_naive() {
            Some((naive, _)) => {
                -(chrono::Local.from_utc_datetime(&naive).offset().fix().local_minus_utc() as f64) / 60.0
            }
            None => f64::NAN,
        }
    }

    pub fn get_full_year(&self) -> i64 {
        self.local_fields().map(|f| f.year).unwrap_or(0)
    }
    /// 0-11
    pub fn get_month(&self) -> i64 {
        self.local_fields().map(|f| f.month).unwrap_or(0)
    }
    pub fn get_date(&self) -> i64 {
        self.local_fields().map(|f| f.day).unwrap_or(0)
    }
    /// 0 = Sunday
    pub fn get_day(&self) -> i64 {
        self.local_fields().map(|f| f.weekday).unwrap_or(0)
    }
    pub fn get_hours(&self) -> i64 {
        self.local_fields().map(|f| f.hour).unwrap_or(0)
    }
    pub fn get_minutes(&self) -> i64 {
        self.local_fields().map(|f| f.minute).unwrap_or(0)
    }
    pub fn get_seconds(&self) -> i64 {
        self.local_fields().map(|f| f.second).unwrap_or(0)
    }
    pub fn get_milliseconds(&self) -> i64 {
        self.local_fields().map(|f| f.ms).unwrap_or(0)
    }
    pub fn get_utc_full_year(&self) -> i64 {
        self.utc_fields().map(|f| f.year).unwrap_or(0)
    }
    pub fn get_utc_month(&self) -> i64 {
        self.utc_fields().map(|f| f.month).unwrap_or(0)
    }
    pub fn get_utc_date(&self) -> i64 {
        self.utc_fields().map(|f| f.day).unwrap_or(0)
    }
    pub fn get_utc_day(&self) -> i64 {
        self.utc_fields().map(|f| f.weekday).unwrap_or(0)
    }
    pub fn get_utc_hours(&self) -> i64 {
        self.utc_fields().map(|f| f.hour).unwrap_or(0)
    }

    /// A copy with the local fields replaced; `None` keeps a field. Fields overflow as in JS.
    #[allow(clippy::too_many_arguments)]
    pub fn with_local(
        &self,
        year: Option<i64>,
        month: Option<i64>,
        day: Option<i64>,
        hour: Option<i64>,
        minute: Option<i64>,
        second: Option<i64>,
        ms: Option<i64>,
    ) -> JsDate {
        let Some(f) = self.local_fields() else { return JsDate::INVALID };
        JsDate::from_local(
            year.unwrap_or(f.year),
            month.unwrap_or(f.month),
            day.unwrap_or(f.day),
            hour.unwrap_or(f.hour),
            minute.unwrap_or(f.minute),
            second.unwrap_or(f.second),
            ms.unwrap_or(f.ms),
        )
    }

    /// `setDate(day)`.
    pub fn set_date(&self, day: i64) -> JsDate {
        self.with_local(None, None, Some(day), None, None, None, None)
    }
    /// `setMonth(month)`.
    pub fn set_month(&self, month: i64) -> JsDate {
        self.with_local(None, Some(month), None, None, None, None, None)
    }
    /// `setFullYear(year)`.
    pub fn set_full_year(&self, year: i64) -> JsDate {
        self.with_local(Some(year), None, None, None, None, None, None)
    }
    /// `setHours(hour, minute, second, ms)`.
    pub fn set_hours(&self, hour: i64, minute: i64, second: i64, ms: i64) -> JsDate {
        self.with_local(None, None, None, Some(hour), Some(minute), Some(second), Some(ms))
    }
    /// `setMilliseconds(ms)`.
    pub fn set_milliseconds(&self, ms: i64) -> JsDate {
        self.with_local(None, None, None, None, None, None, Some(ms))
    }

    /// The date `ms` milliseconds later.
    pub fn plus_ms(&self, ms: f64) -> JsDate {
        JsDate(time_clip(self.0 + ms))
    }

    /// `toISOString()`, or `None` where it would throw a `RangeError`.
    pub fn to_iso_string(&self) -> Option<String> {
        let f = self.utc_fields()?;
        let year = if (0..=9999).contains(&f.year) {
            format!("{:04}", f.year)
        } else if f.year < 0 {
            format!("-{:06}", -f.year)
        } else {
            format!("+{:06}", f.year)
        };
        Some(format!(
            "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            year,
            f.month + 1,
            f.day,
            f.hour,
            f.minute,
            f.second,
            f.ms
        ))
    }

    /// `toJSON()`: the ISO string, or `null` for an invalid date.
    pub fn to_json(&self) -> Json {
        self.to_iso_string().map(Json::String).unwrap_or(Json::Null)
    }

    /// `toLocaleTimeString()` in the default (en-US) locale: `6:48:32 AM`.
    pub fn to_locale_time_string(&self) -> String {
        let Some(f) = self.local_fields() else { return "Invalid Date".to_string() };
        let hour12 = match f.hour % 12 {
            0 => 12,
            h => h,
        };
        format!("{}:{:02}:{:02} {}", hour12, f.minute, f.second, if f.hour < 12 { "AM" } else { "PM" })
    }
}

fn digits(bytes: &[u8], at: usize, count: usize) -> Option<i64> {
    let slice = bytes.get(at..at + count)?;
    if !slice.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    std::str::from_utf8(slice).ok()?.parse().ok()
}

/// The ISO 8601 subset ECMA-262 defines for `Date.parse`. A date alone is
/// UTC; a date with a time and no offset is local time.
fn parse_iso(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let (year, year_len) = match bytes.first()? {
        b'+' | b'-' => {
            let y = digits(bytes, 1, 6)?;
            if bytes[0] == b'-' && y == 0 {
                return None;
            }
            (if bytes[0] == b'-' { -y } else { y }, 7)
        }
        _ => (digits(bytes, 0, 4)?, 4),
    };
    i += year_len;
    let mut month = 1;
    let mut day = 1;
    if bytes.get(i) == Some(&b'-') {
        month = digits(bytes, i + 1, 2)?;
        i += 3;
        if bytes.get(i) == Some(&b'-') {
            day = digits(bytes, i + 1, 2)?;
            i += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // A day past the month's end (`2026-02-30`) rolls into the next month, as JavaScriptCore reads it.
    let date_ms = days_from_civil(year, month - 1, day) * MS_PER_DAY;
    if i == bytes.len() || (i + 1 == bytes.len() && matches!(bytes[i], b'Z' | b'z')) {
        return Some(date_ms);
    }
    if !matches!(bytes[i], b'T' | b't') {
        return None;
    }
    i += 1;
    let hour = digits(bytes, i, 2)?;
    if bytes.get(i + 2) != Some(&b':') {
        return None;
    }
    let minute = digits(bytes, i + 3, 2)?;
    i += 5;
    let mut second = 0;
    let mut ms = 0.0;
    if bytes.get(i) == Some(&b':') {
        second = digits(bytes, i + 1, 2)?;
        i += 3;
        if matches!(bytes.get(i), Some(b'.') | Some(b',')) {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let fraction = format!("0.{}", std::str::from_utf8(&bytes[start..end]).ok()?);
            ms = (fraction.parse::<f64>().ok()? * 1000.0).floor();
            i = end;
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute > 0 || second > 0 || ms > 0.0)) {
        return None;
    }
    let time_ms = make_time(hour as f64, minute as f64, second as f64, ms);
    if i == bytes.len() {
        return Some(local_to_utc_ms(date_ms + time_ms));
    }
    match bytes[i] {
        b'Z' | b'z' if i + 1 == bytes.len() => Some(date_ms + time_ms),
        sign @ (b'+' | b'-') => {
            let offset_hour = digits(bytes, i + 1, 2)?;
            let (offset_minute, end) = if bytes.get(i + 3) == Some(&b':') {
                (digits(bytes, i + 4, 2)?, i + 6)
            } else {
                (digits(bytes, i + 3, 2)?, i + 5)
            };
            if end != bytes.len() || offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let offset = (offset_hour * 60 + offset_minute) as f64 * 60_000.0;
            Some(date_ms + time_ms - if sign == b'+' { offset } else { -offset })
        }
        _ => None,
    }
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// The forms outside ISO 8601 that JavaScriptCore's legacy parser reads and a
/// client might plausibly send: `2024-01-05 10:00`, `2024/01/05`,
/// `01/05/2024`, `Jan 5, 2024`, `5 Jan 2024 10:00:00 GMT`. Without a zone
/// they are local time.
fn parse_legacy(text: &str) -> Option<f64> {
    let lowered = text.trim().to_ascii_lowercase();
    let cleaned = lowered.replace(',', " ");
    let mut tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    if WEEKDAYS.iter().any(|w| tokens[0].starts_with(w)) && tokens[0].chars().all(|c| c.is_ascii_alphabetic()) {
        tokens.remove(0);
    }
    let mut year: Option<i64> = None;
    let mut month: Option<i64> = None;
    let mut day: Option<i64> = None;
    let mut time: Option<(i64, i64, i64)> = None;
    let mut offset_minutes: Option<i64> = None;
    let mut pm: Option<bool> = None;
    let mut loose_numbers: Vec<i64> = Vec::new();

    for token in tokens {
        if let Some(index) = MONTHS.iter().position(|m| token.starts_with(m) && token.chars().all(|c| c.is_ascii_alphabetic())) {
            month = Some(index as i64);
        } else if (token.starts_with('+') || token.starts_with('-')) && time.is_some() {
            offset_minutes = Some(parse_zone(token)?);
        } else if token.contains(':') {
            let (clock, zone) = match token.find(['+', '-', 'z']) {
                Some(at) => (&token[..at], Some(&token[at..])),
                None => (token, None),
            };
            let parts: Vec<&str> = clock.split(':').collect();
            if parts.len() < 2 || parts.len() > 3 {
                return None;
            }
            let hour = parts[0].parse::<i64>().ok()?;
            let minute = parts[1].parse::<i64>().ok()?;
            let second = match parts.get(2) {
                Some(s) => s.split('.').next()?.parse::<i64>().ok()?,
                None => 0,
            };
            if hour > 23 || minute > 59 || second > 59 {
                return None;
            }
            time = Some((hour, minute, second));
            if let Some(zone) = zone {
                offset_minutes = Some(parse_zone(zone)?);
            }
        } else if token == "am" || token == "pm" {
            pm = Some(token == "pm");
        } else if matches!(token, "gmt" | "utc" | "ut" | "z") {
            offset_minutes = Some(offset_minutes.unwrap_or(0));
        } else if token.starts_with("gmt") || token.starts_with("utc") {
            offset_minutes = Some(parse_zone(&token[3..])?);
        } else if token.contains('/') || (token.contains('-') && token.len() > 5) {
            let separator = if token.contains('/') { '/' } else { '-' };
            let parts: Vec<i64> = token.split(separator).map(|p| p.parse::<i64>()).collect::<Result<_, _>>().ok()?;
            if parts.len() != 3 {
                return None;
            }
            if token.split(separator).next()?.len() == 4 {
                year = Some(parts[0]);
                month = Some(parts[1] - 1);
                day = Some(parts[2]);
            } else {
                month = Some(parts[0] - 1);
                day = Some(parts[1]);
                year = Some(parts[2]);
            }
        } else if let Ok(number) = token.parse::<i64>() {
            loose_numbers.push(number);
        } else {
            return None;
        }
    }

    for number in loose_numbers {
        if day.is_none() && (1..=31).contains(&number) && month.is_some() {
            day = Some(number);
        } else if year.is_none() {
            year = Some(number);
        } else if day.is_none() && (1..=31).contains(&number) {
            day = Some(number);
        } else {
            return None;
        }
    }

    let (year, month, day) = (year?, month?, day?);
    if !(0..=11).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, minute, second) = time.unwrap_or((0, 0, 0));
    if let Some(is_pm) = pm {
        if hour > 12 {
            return None;
        }
        hour = hour % 12 + if is_pm { 12 } else { 0 };
    }
    let wall = days_from_civil(year, month, day) * MS_PER_DAY + make_time(hour as f64, minute as f64, second as f64, 0.0);
    Some(match offset_minutes {
        Some(offset) => wall - offset as f64 * 60_000.0,
        None => local_to_utc_ms(wall),
    })
}

fn parse_zone(zone: &str) -> Option<i64> {
    if zone.is_empty() || zone == "z" {
        return Some(0);
    }
    let sign = match zone.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = zone[1..].replace(':', "");
    let (hours, minutes) = match rest.len() {
        1 | 2 => (rest.parse::<i64>().ok()?, 0),
        4 => (rest[..2].parse::<i64>().ok()?, rest[2..].parse::<i64>().ok()?),
        _ => return None,
    };
    Some(sign * (hours * 60 + minutes))
}

/// `Date.parse(text)`: milliseconds since the epoch, or NaN.
pub fn date_parse(text: &str) -> f64 {
    let trimmed = text.trim();
    let ms = parse_iso(trimmed).or_else(|| parse_legacy(trimmed)).unwrap_or(f64::NAN);
    time_clip(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_like_js() {
        assert_eq!(number_to_string(5.0), "5");
        assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(123456789012345680000.0), "123456789012345680000");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-1.2345e25), "-1.2345e+25");
        assert_eq!(number_to_string(1e300), "1e+300");
        assert_eq!(number_to_string(5e-324), "5e-324");
        assert_eq!(number_to_string(-123.456), "-123.456");
        assert_eq!(number_to_string(1e20), "100000000000000000000");
    }

    // The literals are the exact doubles whose shortest digits tie.
    #[allow(clippy::excessive_precision)]
    #[test]
    fn number_to_string_takes_the_even_of_two_equally_close_digits() {
        // As Bun prints them.
        assert_eq!(number_to_string(900719925474099.25), "900719925474099.2");
        assert_eq!(number_to_string(135130428281141.625), "135130428281141.62");
        assert_eq!(number_to_string(-900719925474099.25), "-900719925474099.2");
        assert_eq!(number_to_string(900719925474099.75), "900719925474099.8");
    }

    #[test]
    fn math_round_rounds_halves_up_and_nothing_else() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-2.50001), -3.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert_eq!(math_round(4503599627370497.0), 4503599627370497.0);
        assert_eq!(math_round(9007199254740991.0), 9007199254740991.0);
        assert!(math_round(-0.5).is_sign_negative() && math_round(-0.5) == 0.0);
        assert!(math_round(-0.49999999999999994).is_sign_negative());
        assert_eq!(math_round(-0.5000000000000001), -1.0);
        assert!(math_round(f64::NAN).is_nan());
        assert_eq!(math_round(f64::NEG_INFINITY), f64::NEG_INFINITY);
        assert_eq!(math_round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn to_fixed_rounds_ties_up() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(1234.5, 2), "1234.50");
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.005, 2), "-0.01");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
    }

    #[test]
    fn parses_iso_dates() {
        assert_eq!(date_parse("2024-01-05"), 1_704_412_800_000.0);
        assert_eq!(date_parse("2024-01-05T10:11:12.123Z"), 1_704_449_472_123.0);
        assert_eq!(date_parse("2024-01-05T10:11:12+02:00"), 1_704_442_272_000.0);
        assert_eq!(date_parse("2026-02-30"), 1_772_409_600_000.0);
        assert!(date_parse("2026-02-32").is_nan());
        assert!(date_parse("2026-13-01").is_nan());
        assert_eq!(date_parse("2024-01-05T10:11:12-0800"), 1_704_478_272_000.0);
        assert_eq!(date_parse("2024-01-05Z"), 1_704_412_800_000.0);
        assert_eq!(date_parse("2024-01-05T10:11:12.123456789Z"), 1_704_449_472_123.0);
        assert_eq!(date_parse("Fri, 05 Jan 2024 10:11:12 GMT"), 1_704_449_472_000.0);
        assert_eq!(date_parse("2024-01-05 10:11:12 +02:00"), 1_704_442_272_000.0);
        assert!(date_parse("2024-01-05T10:11:12+02").is_nan());
        assert!(date_parse("2024-01-05T24:00:01").is_nan());
        assert!(date_parse("2024-01-05Tgarbage").is_nan());
        assert!(date_parse("not a date").is_nan());
    }

    #[test]
    fn iso_string_round_trips() {
        assert_eq!(JsDate(1_704_449_472_123.0).to_iso_string().unwrap(), "2024-01-05T10:11:12.123Z");
        assert_eq!(JsDate(-1.0).to_iso_string().unwrap(), "1969-12-31T23:59:59.999Z");
        assert!(JsDate::INVALID.to_iso_string().is_none());
    }

    #[test]
    fn uri_component_matches_js() {
        assert_eq!(encode_uri_component("a b&c/d:é'()*!~"), "a%20b%26c%2Fd%3A%C3%A9'()*!~");
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert!(decode_uri_component("%E0%A4%A").is_none());
    }

    #[test]
    fn numbers_normalize_to_doubles() {
        let mut value = serde_json::json!({ "a": 5.0, "b": 9007199254740993u64, "c": 1.5 });
        normalize_numbers(&mut value);
        assert_eq!(json_stringify(&value), r#"{"a":5,"b":9007199254740992,"c":1.5}"#);
        let odd = serde_json::json!([0.0000015, 9000000000000000000u64, 1234567890123456789u64, -0.0, 1e21, "a\"b\n"]);
        assert_eq!(json_stringify(&odd), r#"[0.0000015,9000000000000000000,1234567890123456800,0,1e+21,"a\"b\n"]"#);
    }
}
