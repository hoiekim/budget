//! JavaScript value semantics the TypeScript backend leans on, reproduced so
//! the two servers agree on edge cases: truthiness, `typeof`, number
//! formatting, `Date` parsing and local-time arithmetic, URI encoding.
//!
//! Request bodies, database rows and responses are all `serde_json::Value`
//! (`Json`) here, with object keys in insertion order, the way the TypeScript
//! code holds them as plain objects. An absent key stands for `undefined`.

use chrono::{DateTime, Datelike, NaiveDateTime, Offset, TimeZone, Timelike, Utc};
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

/// Appends `text` as a JSON string literal, escaped as `JSON.stringify`
/// escapes it: `"` and `\`, the short forms of five control characters,
/// `\u00xx` for the other control characters, everything else as is.
fn write_json_string(text: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    let mut start = 0;
    for (index, byte) in text.bytes().enumerate() {
        let short = match byte {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0x08 => "\\b",
            0x0c => "\\f",
            0x00..=0x1f => "",
            _ => continue,
        };
        // Every escaped byte is ASCII, so `index` is a character boundary.
        out.push_str(&text[start..index]);
        if short.is_empty() {
            out.push_str("\\u00");
            out.push(HEX[usize::from(byte >> 4)] as char);
            out.push(HEX[usize::from(byte & 0xf)] as char);
        } else {
            out.push_str(short);
        }
        start = index + 1;
    }
    out.push_str(&text[start..]);
    out.push('"');
}

/// `JSON.stringify(value)` appended to `out`.
pub fn write_json(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // The digits `Number.prototype.toString` writes, so text that is
        // stored or hashed is the same on both servers.
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            // A safe integer prints as its digits; past 2^53 `toString` pads the shortest digits with zeros.
            (Some(integer), _) if integer.unsigned_abs() <= MAX_SAFE_INTEGER as u64 => {
                use std::fmt::Write as _;
                let _ = write!(out, "{integer}");
            }
            (_, Some(f)) if f.is_finite() => out.push_str(&number_to_string(f)),
            _ => out.push_str("null"),
        },
        Json::String(text) => write_json_string(text, out),
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
                write_json_string(key, out);
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
    // Hexadecimal, octal and binary integer literals, digits only (no sign).
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|prefix| trimmed.strip_prefix(prefix)) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return u64::from_str_radix(digits, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
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

/// The epoch milliseconds of a local wall-clock time, as JavaScriptCore's
/// `DateCache::localTimeToMS` computes it: the local time minus the zone's
/// offset at that wall-clock time (see `local_time_offset_ms`). Beyond a day
/// past the time range the value is left alone (the caller's clip makes it NaN).
fn local_to_utc_ms(local_ms: f64) -> f64 {
    if !local_ms.is_finite() || local_ms.abs() > MAX_TIME + MS_PER_DAY {
        return local_ms;
    }
    local_ms - local_time_offset_ms(local_ms as i64) as f64
}

const MS_PER_DAY_I64: i64 = 86_400_000;
const MAX_TIME_I64: i64 = 8_640_000_000_000_000;

/// The zone's offset (UTC to local, in milliseconds) that applies to a local
/// wall-clock time, as JavaScriptCore's `DateCache::localTimeOffset(ms,
/// TimeType::LocalTime)` finds it: a time past the ECMAScript range is first
/// moved to the equivalent year (`WTF::equivalentTime`), then ICU's
/// `getTimeZoneOffsetFromLocal(UCAL_TZ_LOCAL_FORMER, UCAL_TZ_LOCAL_FORMER)`
/// answers. "Former" means the offset in force before the nearest transition
/// whenever the wall-clock time is ambiguous: a time in a gap (clocks moved
/// forward) uses the offset from before the gap, so 02:30 on a spring-forward
/// night in Los Angeles is 10:30Z (03:30 PDT), and a time that happens twice
/// is its first occurrence, so 01:30 on a fall-back night is 08:30Z (PDT).
fn local_time_offset_ms(local_ms: i64) -> i64 {
    let local_ms = if (-MAX_TIME_I64..=MAX_TIME_I64).contains(&local_ms) { local_ms } else { equivalent_time(local_ms) };
    // ICU compares whole seconds against transitions, which fall on whole seconds.
    former_offset_seconds(local_ms.div_euclid(1000), utc_offset_seconds) * 1000
}

/// The offset (seconds) that applies to the wall-clock time `wall` (local
/// seconds, read as if UTC) in the zone whose offset at a UTC instant is
/// `offset_at`, resolving gaps and repeats to the offset before the transition.
fn former_offset_seconds(wall: i64, offset_at: impl Fn(i64) -> i64) -> i64 {
    // No zone is a day or more away from UTC, so any transition that bears on
    // this wall-clock time lies between these two instants.
    let before = offset_at(wall - 86_400);
    let after = offset_at(wall + 86_400);
    if offset_at(wall - before) == before {
        // Not in a gap, and the first reading if it is repeated.
        before
    } else if offset_at(wall - after) == after {
        after
    } else {
        // In a gap.
        before
    }
}

/// The zone's offset (UTC to local, in seconds) at an instant. Instants beyond
/// the years chrono represents are moved by whole 400-year cycles, over which
/// the calendar repeats: far in the future the zone's last rule applies, which
/// recurs with the calendar, and far in the past its first (local mean) time.
fn utc_offset_seconds(utc_seconds: i64) -> i64 {
    const CYCLE: i64 = 146_097 * 86_400;
    // 10000-01-01T00:00:00Z and -10000-01-01T00:00:00Z.
    const HIGH: i64 = 253_402_300_800;
    const LOW: i64 = -377_736_739_200;
    let mut seconds = utc_seconds;
    if seconds >= HIGH {
        seconds -= ((seconds - HIGH) / CYCLE + 1) * CYCLE;
    } else if seconds < LOW {
        seconds += ((LOW - 1 - seconds) / CYCLE + 1) * CYCLE;
    }
    match DateTime::from_timestamp(seconds, 0) {
        Some(dt) => chrono::Local.offset_from_utc_datetime(&dt.naive_utc()).fix().local_minus_utc() as i64,
        None => 0,
    }
}

/// `WTF::equivalentTime`: the same moment of the year in a year from 2008 to
/// 2037 that is equally leap and starts on the same day of the week.
fn equivalent_time(ms: i64) -> i64 {
    let days = ms.div_euclid(MS_PER_DAY_I64);
    let time_within_day = ms - days * MS_PER_DAY_I64;
    let (year, month0, day) = civil_from_days(days);
    let new_days = days_from_year_month(equivalent_year(year), month0) + day - 1;
    new_days * MS_PER_DAY_I64 + time_within_day
}

/// `WTF::equivalentYear`.
fn equivalent_year(year: i64) -> i64 {
    let week_day = (days_from_year_month(year, 0) + 4).rem_euclid(7);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let recent_year = (if leap { 1956 } else { 1967 }) + (week_day * 12) % 28;
    2008 + (recent_year + 3 * 28 - 2008) % 28
}

/// Days from 1970-01-01 to the first of a month (`month0` 0-11).
fn days_from_year_month(year: i64, month0: i64) -> i64 {
    days_from_civil(year, month0, 1) as i64
}

/// The proleptic Gregorian (year, month 0-11, day) of a day number counted from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month - 1, day)
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

// ---------------------------------------------------------------------------
// Date.parse
// ---------------------------------------------------------------------------
//
// Bun's JavaScriptCore does not parse dates with WTF's `parseES5Date` and
// `parseDate`: `Options::useV8DateParser` is on, so `DateCache::parseDate`
// (`Source/JavaScriptCore/runtime/JSDateMath.cpp` in oven-sh/WebKit) hands the
// text to a port of V8's date parser (`JSDateMath-v8.cpp`, from V8's
// `src/date/dateparser*`). What follows ports both, step for step, so the
// quirks come along: a lone number is a month (`"12"` is 2001-12-01), the
// default year is 2001 (`"Dec 25"`), any word before the first number is
// skipped, digits past the ninth are dropped, NUL ends the text.

/// Marks a field the text did not give (`kNone`).
const NONE: i32 = i32::MAX;
/// Digits of a numeral past these are read but ignored (`kMaxSignificantDigits`).
const MAX_SIGNIFICANT_DIGITS: usize = 9;

/// `static_cast<unsigned>(x - lo) <= static_cast<unsigned>(hi - lo)`.
fn between(x: i32, lo: i32, hi: i32) -> bool {
    (x.wrapping_sub(lo) as u32) <= (hi.wrapping_sub(lo) as u32)
}

/// `isASCIIWhitespace`: no vertical tab.
fn is_ascii_white_space(ch: u8) -> bool {
    matches!(ch, b' ' | b'\n' | b'\t' | b'\r' | 0x0C)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum KeywordType {
    /// A word that is none of the others (`INVALID`).
    Other,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

/// `KeywordTable::array`: a word matches an entry by its first three letters
/// (lowercased, zero-padded); only month names may be longer.
const KEYWORDS: [([u8; 3], KeywordType, i32); 27] = [
    (*b"jan", KeywordType::MonthName, 1),
    (*b"feb", KeywordType::MonthName, 2),
    (*b"mar", KeywordType::MonthName, 3),
    (*b"apr", KeywordType::MonthName, 4),
    (*b"may", KeywordType::MonthName, 5),
    (*b"jun", KeywordType::MonthName, 6),
    (*b"jul", KeywordType::MonthName, 7),
    (*b"aug", KeywordType::MonthName, 8),
    (*b"sep", KeywordType::MonthName, 9),
    (*b"oct", KeywordType::MonthName, 10),
    (*b"nov", KeywordType::MonthName, 11),
    (*b"dec", KeywordType::MonthName, 12),
    (*b"am\0", KeywordType::AmPm, 0),
    (*b"pm\0", KeywordType::AmPm, 12),
    (*b"ut\0", KeywordType::TimeZoneName, 0),
    (*b"utc", KeywordType::TimeZoneName, 0),
    (*b"z\0\0", KeywordType::TimeZoneName, 0),
    (*b"gmt", KeywordType::TimeZoneName, 0),
    (*b"cdt", KeywordType::TimeZoneName, -5),
    (*b"cst", KeywordType::TimeZoneName, -6),
    (*b"edt", KeywordType::TimeZoneName, -4),
    (*b"est", KeywordType::TimeZoneName, -5),
    (*b"mdt", KeywordType::TimeZoneName, -6),
    (*b"mst", KeywordType::TimeZoneName, -7),
    (*b"pdt", KeywordType::TimeZoneName, -7),
    (*b"pst", KeywordType::TimeZoneName, -8),
    (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

fn lookup_keyword(prefix: [u8; 3], length: usize) -> (KeywordType, i32) {
    KEYWORDS
        .iter()
        .find(|(word, kind, _)| *word == prefix && (length <= 3 || *kind == KeywordType::MonthName))
        .map(|&(_, kind, value)| (kind, value))
        .unwrap_or((KeywordType::Other, 0))
}

#[derive(Clone, Copy, Debug)]
enum DateToken {
    Invalid,
    Unknown,
    /// The value of the first nine significant digits, and the numeral's length.
    Number(i32, usize),
    Symbol(u8),
    WhiteSpace,
    EndOfInput,
    Keyword(KeywordType, i32, usize),
}

impl DateToken {
    fn is_number(self) -> bool {
        matches!(self, DateToken::Number(..))
    }
    fn is_fixed_length_number(self, length: usize) -> bool {
        matches!(self, DateToken::Number(_, l) if l == length)
    }
    fn number(self) -> i32 {
        match self {
            DateToken::Number(n, _) => n,
            _ => 0,
        }
    }
    fn is_symbol(self, symbol: u8) -> bool {
        matches!(self, DateToken::Symbol(s) if s == symbol)
    }
    fn is_ascii_sign(self) -> bool {
        matches!(self, DateToken::Symbol(b'+' | b'-'))
    }
    /// 1 for `+`, -1 for `-`.
    fn ascii_sign(self) -> i32 {
        match self {
            DateToken::Symbol(s) => 44 - s as i32,
            _ => 0,
        }
    }
    fn is_keyword_type(self, kind: KeywordType) -> bool {
        matches!(self, DateToken::Keyword(k, _, _) if k == kind)
    }
    fn is_keyword_z(self) -> bool {
        matches!(self, DateToken::Keyword(KeywordType::TimeZoneName, 0, 1))
    }
}

/// `InputReader`: the text one byte at a time, 0 past the end.
struct InputReader<'a> {
    buffer: &'a [u8],
    index: usize,
    ch: u8,
}

impl<'a> InputReader<'a> {
    fn new(buffer: &'a [u8]) -> Self {
        let mut reader = InputReader { buffer, index: 0, ch: 0 };
        reader.next();
        reader
    }
    fn next(&mut self) {
        self.ch = self.buffer.get(self.index).copied().unwrap_or(0);
        self.index += 1;
    }
    fn read_unsigned_numeral(&mut self) -> i32 {
        let mut n = 0;
        let mut i = 0;
        while self.ch == b'0' {
            self.next();
        }
        while self.ch.is_ascii_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + (self.ch - b'0') as i32;
            }
            i += 1;
            self.next();
        }
        n
    }
    /// A word is a run of bytes from `A` up (any non-ASCII byte included).
    fn read_word(&mut self) -> ([u8; 3], usize) {
        let mut prefix = [0u8; 3];
        let mut length = 0;
        while self.ch >= b'A' && !is_ascii_white_space(self.ch) {
            if length < 3 {
                prefix[length] = self.ch | 0x20;
            }
            length += 1;
            self.next();
        }
        (prefix, length)
    }
    fn skip(&mut self, c: u8) -> bool {
        if self.ch == c {
            self.next();
            true
        } else {
            false
        }
    }
    fn skip_white_space(&mut self) -> bool {
        if is_ascii_white_space(self.ch) || self.ch == b'\n' || self.ch == b'\r' {
            self.next();
            true
        } else {
            false
        }
    }
    fn skip_parentheses(&mut self) -> bool {
        if self.ch != b'(' {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == b')' {
                balance -= 1;
            } else if self.ch == b'(' {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch != 0) {
                break;
            }
        }
        true
    }
}

/// `DateStringTokenizer`: one token of lookahead.
struct DateStringTokenizer<'a> {
    input: InputReader<'a>,
    next: DateToken,
}

impl<'a> DateStringTokenizer<'a> {
    fn new(buffer: &'a [u8]) -> Self {
        let mut input = InputReader::new(buffer);
        let next = Self::scan(&mut input);
        DateStringTokenizer { input, next }
    }
    fn next(&mut self) -> DateToken {
        let result = self.next;
        self.next = Self::scan(&mut self.input);
        result
    }
    fn peek(&self) -> DateToken {
        self.next
    }
    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next.is_symbol(symbol) {
            self.next = Self::scan(&mut self.input);
            true
        } else {
            false
        }
    }
    fn scan(input: &mut InputReader) -> DateToken {
        let pre_pos = input.index;
        if input.ch == 0 {
            return DateToken::EndOfInput;
        }
        if input.ch.is_ascii_digit() {
            let n = input.read_unsigned_numeral();
            return DateToken::Number(n, input.index - pre_pos);
        }
        for symbol in *b":-+.)" {
            if input.skip(symbol) {
                return DateToken::Symbol(symbol);
            }
        }
        if input.ch >= b'A' && !is_ascii_white_space(input.ch) {
            let (prefix, length) = input.read_word();
            let (kind, value) = lookup_keyword(prefix, length);
            return DateToken::Keyword(kind, value, length);
        }
        if input.skip_white_space() {
            return DateToken::WhiteSpace;
        }
        if input.skip_parentheses() {
            return DateToken::Unknown;
        }
        input.next();
        DateToken::Unknown
    }
}

/// `TimeZoneComposer`.
struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }
    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && TimeComposer::is_minute(n)
    }
    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    fn is_empty(&self) -> bool {
        self.hour == NONE
    }
    /// The offset in seconds, NaN for none, or `None` when it is out of range.
    fn write(&mut self) -> Option<f64> {
        if self.sign == NONE {
            return Some(f64::NAN);
        }
        if self.hour == NONE {
            self.hour = 0;
        }
        if self.minute == NONE {
            self.minute = 0;
        }
        // Unsigned arithmetic, wrapping, as V8 does it to dodge signed overflow.
        let total = (self.hour as u32).wrapping_mul(3600).wrapping_add((self.minute as u32).wrapping_mul(60));
        if total > i32::MAX as u32 {
            return None;
        }
        let total = if self.sign < 0 { -(total as i32) } else { total as i32 };
        Some(total as f64)
    }
}

/// `TimeComposer`: hour, minute, second, millisecond.
struct TimeComposer {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && Self::is_minute(n)) || (self.index == 2 && Self::is_second(n)) || (self.index == 3 && Self::is_millisecond(n))
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 4 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }
    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }
    fn is_minute(x: i32) -> bool {
        between(x, 0, 59)
    }
    fn is_hour(x: i32) -> bool {
        between(x, 0, 23)
    }
    fn is_second(x: i32) -> bool {
        between(x, 0, 59)
    }
    fn is_hour12(x: i32) -> bool {
        between(x, 0, 12)
    }
    fn is_millisecond(x: i32) -> bool {
        between(x, 0, 999)
    }
    fn write(&mut self) -> Option<[i32; 4]> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !Self::is_hour12(hour) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        if !Self::is_hour(hour) || !Self::is_minute(minute) || !Self::is_second(second) || !Self::is_millisecond(millisecond) {
            // 24:00:00.000 is allowed.
            if hour != 24 || minute != 0 || second != 0 || millisecond != 0 {
                return None;
            }
        }
        Some([hour, minute, second, millisecond])
    }
}

/// `DayComposer`: up to three numbers and a month name.
struct DayComposer {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 3 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }
    fn is_month(x: i32) -> bool {
        between(x, 1, 12)
    }
    fn is_day(x: i32) -> bool {
        between(x, 1, 31)
    }
    /// (year, month 0-11, day).
    fn write(&mut self) -> Option<[i32; 3]> {
        if self.index < 1 {
            return None;
        }
        // Day and month default to 1.
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let mut year = 0; // Year 0 is 2000, for KJS compatibility.
        let month;
        let day;
        if self.named_month == NONE {
            if self.is_iso_date || (self.index == 3 && !Self::is_day(self.comp[0])) {
                // YMD
                year = self.comp[0];
                month = self.comp[1];
                day = self.comp[2];
            } else {
                // MD(Y)
                month = self.comp[0];
                day = self.comp[1];
                if self.index == 3 {
                    year = self.comp[2];
                }
            }
        } else {
            month = self.named_month;
            if self.index == 1 {
                // MD or DM
                day = self.comp[0];
            } else if !Self::is_day(self.comp[0]) {
                // YMD, MYD, or YDM
                year = self.comp[0];
                day = self.comp[1];
            } else {
                // DMY, MDY, or DYM
                day = self.comp[0];
                year = self.comp[1];
            }
        }
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        if !Self::is_month(month) || !Self::is_day(day) {
            return None;
        }
        Some([year, month - 1, day])
    }
}

/// `DateParser::ReadMilliseconds`: the first three significant digits of the
/// numeral, judged by its length, so leading zeros count.
fn read_milliseconds(token: DateToken) -> i32 {
    let DateToken::Number(mut number, mut length) = token else { return 0 };
    if length == 1 {
        number *= 100;
    } else if length == 2 {
        number *= 10;
    } else if length > 3 {
        length = length.min(MAX_SIGNIFICANT_DIGITS);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

/// `DateParser::ParseES5DateTime`: as much of the text as reads as the ECMAScript
/// date-time format. Returns the first token it did not use, `EndOfInput` when
/// the whole text was that format, or `Invalid` when it went wrong past the `T`.
fn parse_es5_date_time(
    scanner: &mut DateStringTokenizer,
    day: &mut DayComposer,
    time: &mut TimeComposer,
    tz: &mut TimeZoneComposer,
) -> DateToken {
    // [('-'|'+')yy]yyyy['-'MM['-'DD]]
    if scanner.peek().is_ascii_sign() {
        // Kept to hand back to the legacy parser if unused.
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !DayComposer::is_month(scanner.peek().number()) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !DayComposer::is_day(scanner.peek().number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    // 'T'HH':'mm[':'ss['.'sss]][Z|('+'|'-')hh[':']mm]
    if !scanner.peek().is_keyword_type(KeywordType::TimeSeparator) {
        if !matches!(scanner.peek(), DateToken::EndOfInput) {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return DateToken::Invalid;
        }
        // 24:00[:00[.000]] is allowed, no other time in hour 24.
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return DateToken::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !TimeComposer::is_minute(scanner.peek().number())
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return DateToken::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !TimeComposer::is_second(scanner.peek().number())
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return DateToken::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return DateToken::Invalid;
                }
                // Any number of digits.
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_symbol(b'+') || scanner.peek().is_symbol(b'-') {
            tz.set_sign(if scanner.next().is_symbol(b'+') { 1 } else { -1 });
            if scanner.peek().is_fixed_length_number(4) {
                // hhmm
                let hourmin = scanner.next().number();
                let (hour, minute) = (hourmin / 100, hourmin % 100);
                if !TimeComposer::is_hour(hour) || !TimeComposer::is_minute(minute) {
                    return DateToken::Invalid;
                }
                tz.hour = hour;
                tz.minute = minute;
            } else {
                // hh:mm
                if !scanner.peek().is_fixed_length_number(2) || !TimeComposer::is_hour(scanner.peek().number()) {
                    return DateToken::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return DateToken::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2) || !TimeComposer::is_minute(scanner.peek().number()) {
                    return DateToken::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if !matches!(scanner.peek(), DateToken::EndOfInput) {
            return DateToken::Invalid;
        }
    }
    // A date alone is UTC, a date and time without an offset local time.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    DateToken::EndOfInput
}

/// `DateParser::Parse`: (year, month 0-11, day, hour, minute, second, ms,
/// UTC offset in seconds or NaN), or `None` when the text is not a date.
fn parse_date_fields(bytes: &[u8]) -> Option<[f64; 8]> {
    let mut scanner = DateStringTokenizer::new(bytes);
    let mut tz = TimeZoneComposer { sign: NONE, hour: NONE, minute: NONE };
    let mut time = TimeComposer { comp: [0; 4], index: 0, hour_offset: NONE };
    let mut day = DayComposer { comp: [0; 3], index: 0, named_month: NONE, is_iso_date: false };

    // As far as the text goes as the ECMAScript format, then the legacy rules:
    // an unsigned number followed by ':' is a time field ('::' adds a zero
    // second, '.' must be followed by milliseconds), any other number a date
    // field, a word with a month's first three letters names the month, a time
    // zone word or '(+|-)(hhmm|hh:)' sets the offset, parenthesized text and
    // any word before the first number are skipped. After a number, a stray
    // word, sign or ')' makes the text invalid.
    let mut token = parse_es5_date_time(&mut scanner, &mut day, &mut time, &mut tz);
    if matches!(token, DateToken::Invalid) {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    while !matches!(token, DateToken::EndOfInput) {
        if let DateToken::Number(n, _) = token {
            has_read_number = true;
            if scanner.skip_symbol(b':') {
                if scanner.skip_symbol(b':') {
                    // n + "::"
                    if !time.is_empty() {
                        return None;
                    }
                    time.add(n);
                    time.add(0);
                } else {
                    // n + ":"
                    if !time.add(n) {
                        return None;
                    }
                    if scanner.peek().is_symbol(b'.') {
                        scanner.next();
                    }
                }
            } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                time.add(n);
                if !scanner.peek().is_number() {
                    return None;
                }
                let ms = read_milliseconds(scanner.next());
                if ms < 0 {
                    return None;
                }
                time.add_final(ms);
            } else if tz.is_expecting(n) {
                tz.minute = n;
            } else if time.is_expecting(n) {
                time.add_final(n);
                // The end, white space, "Z", "+" or "-" must follow a finished time.
                let peek = scanner.peek();
                if !matches!(peek, DateToken::EndOfInput | DateToken::WhiteSpace) && !peek.is_keyword_z() && !peek.is_ascii_sign() {
                    return None;
                }
            } else {
                if !day.add(n) {
                    return None;
                }
                scanner.skip_symbol(b'-');
            }
        } else if let DateToken::Keyword(kind, value, _) = token {
            if kind == KeywordType::AmPm && !time.is_empty() {
                time.hour_offset = value;
            } else if kind == KeywordType::MonthName {
                day.named_month = value;
                scanner.skip_symbol(b'-');
            } else if kind == KeywordType::TimeZoneName && has_read_number {
                tz.set(value);
            } else {
                // A stray word after a number, or one stuck to the first number.
                if has_read_number || scanner.peek().is_number() {
                    return None;
                }
            }
        } else if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) {
            // A UTC offset, after a time or a UTC word.
            tz.set_sign(token.ascii_sign());
            let (mut n, mut length) = (0, 0);
            if let DateToken::Number(value, l) = scanner.peek() {
                scanner.next();
                n = value;
                length = l;
            }
            has_read_number = true;
            if scanner.peek().is_symbol(b':') {
                tz.hour = n;
                tz.minute = NONE;
            } else if length == 1 || length == 2 {
                // GMT-8
                tz.hour = n;
                tz.minute = 0;
            } else if length == 3 || length == 4 {
                // hhmm
                tz.hour = n / 100;
                tz.minute = n % 100;
            } else {
                return None;
            }
        } else if (token.is_ascii_sign() || token.is_symbol(b')')) && has_read_number {
            return None;
        }
        // Anything else (white space, other characters) is skipped.
        token = scanner.next();
    }

    let [year, month, day_of_month] = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let offset = tz.write()?;
    Some([
        year as f64,
        month as f64,
        day_of_month as f64,
        hour as f64,
        minute as f64,
        second as f64,
        millisecond as f64,
        offset,
    ])
}

/// V8's `MakeDay`, for the integral fields the parser produces.
fn v8_make_day(year: f64, month: f64, date: f64) -> f64 {
    if !(-1_000_000.0..=1_000_000.0).contains(&year) || !(-10_000_000.0..=10_000_000.0).contains(&month) || !date.is_finite() {
        return f64::NAN;
    }
    let mut y = year as i64;
    let mut m = month as i64;
    y += m / 12;
    m %= 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    const YEAR_DELTA: i64 = 399_999;
    const BASE_DAY: i64 =
        365 * (1970 + YEAR_DELTA) + (1970 + YEAR_DELTA) / 4 - (1970 + YEAR_DELTA) / 100 + (1970 + YEAR_DELTA) / 400;
    let mut day_from_year =
        365 * (y + YEAR_DELTA) + (y + YEAR_DELTA) / 4 - (y + YEAR_DELTA) / 100 + (y + YEAR_DELTA) / 400 - BASE_DAY;
    const DAY_FROM_MONTH: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const DAY_FROM_MONTH_LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    if y % 4 != 0 || (y % 100 == 0 && y % 400 != 0) {
        day_from_year += DAY_FROM_MONTH[m as usize];
    } else {
        day_from_year += DAY_FROM_MONTH_LEAP[m as usize];
    }
    (day_from_year - 1) as f64 + date.trunc()
}

/// The UTC offset JavaScriptCore subtracts from a local date-time is only
/// looked up within a month of the time range (`kMaxTimeBeforeUTCInMs`).
const MAX_TIME_BEFORE_UTC: f64 = MAX_TIME + 30.0 * MS_PER_DAY;

/// `Date.parse(text)`: milliseconds since the epoch, or NaN. Text without a
/// UTC offset is local time in the process time zone (`TZ`), except a date
/// alone in the ECMAScript format (`2024-01-05`), which is UTC.
pub fn date_parse(text: &str) -> f64 {
    // `DateCache::parseDate` folds white space into ASCII spaces before
    // parsing the UTF-8 bytes: in a string of Latin-1 characters only the
    // no-break space; in any other string every ECMAScript WhiteSpace
    // (vertical tab, no-break space, BOM, Unicode Zs). Line terminators stay.
    let folded;
    let bytes = if text.is_ascii() {
        text.as_bytes()
    } else {
        let wide = text.chars().any(|c| c as u32 > 0xFF);
        folded = text
            .chars()
            .map(|c| {
                let white = matches!(
                    c,
                    '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{FEFF}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
                );
                if c == '\u{00A0}' || (wide && white) {
                    ' '
                } else {
                    c
                }
            })
            .collect::<String>();
        folded.as_bytes()
    };
    let Some(fields) = parse_date_fields(bytes) else { return f64::NAN };
    // V8's `ParseDateTimeString`.
    let day = v8_make_day(fields[0], fields[1], fields[2]);
    let time = make_time(fields[3], fields[4], fields[5], fields[6]);
    let mut date = if day.is_finite() { time + day * MS_PER_DAY } else { f64::NAN };
    if fields[7].is_nan() {
        if !(-MAX_TIME_BEFORE_UTC..=MAX_TIME_BEFORE_UTC).contains(&date) {
            return f64::NAN;
        }
        date -= local_time_offset_ms(date as i64) as f64;
    } else {
        date -= fields[7] * 1000.0;
    }
    time_clip(date)
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
    fn to_number_reads_what_number_reads() {
        assert_eq!(to_number(" 12.5 "), 12.5);
        assert_eq!(to_number(""), 0.0);
        assert_eq!(to_number("0x10"), 16.0);
        assert_eq!(to_number("0o17"), 15.0);
        assert_eq!(to_number("0B101"), 5.0);
        for text in ["0x", "0b2", "0o8", "0x+1", "-0x10", "1,000", "abc"] {
            assert!(to_number(text).is_nan(), "{text}");
        }
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
    fn an_iso_date_time_is_read_as_written() {
        // White space around the ISO form with a `T` is not skipped: JavaScriptCore reads NaN.
        assert!(date_parse(" 2024-01-05T10:11:12Z").is_nan());
        assert!(date_parse("2024-01-05T10:11:12Z ").is_nan());
        assert!(date_parse("\t2024-01-05T10:11:12.123+02:00\n").is_nan());
        // The legacy forms skip it.
        assert_eq!(date_parse(" Fri, 05 Jan 2024 10:11:12 GMT "), 1_704_449_472_000.0);
        assert_eq!(date_parse("  2024-01-05 10:11:12 +02:00 "), 1_704_442_272_000.0);
    }

    /// Equal, NaN included.
    fn same(a: f64, b: f64) -> bool {
        a == b || (a.is_nan() && b.is_nan())
    }

    // Expected values from Bun 1.4.4.
    #[test]
    fn parses_the_ecmascript_format_like_bun() {
        assert_eq!(date_parse("2024-01-05T10:11:12.5Z"), 1_704_449_472_500.0);
        assert_eq!(date_parse("2024-01-05t10:11:12z"), 1_704_449_472_000.0);
        assert_eq!(date_parse("2024-01-05T10:11Z"), 1_704_449_460_000.0);
        assert_eq!(date_parse("2024-01-05T24:00:00Z"), 1_704_499_200_000.0);
        assert_eq!(date_parse("2024-01-05T10:11:12+23:59"), 1_704_363_132_000.0);
        assert_eq!(date_parse("1970-01-01T00:00:00.000+00:00"), 0.0);
        assert_eq!(date_parse("2024-02-30"), 1_709_251_200_000.0);
        assert!(date_parse("2024-01-05T10:11:12,5").is_nan());
        assert!(date_parse("2024-01-05T24:00:01Z").is_nan());
        assert!(date_parse("2024-01-05T10:11:12+24:00").is_nan());
        assert!(date_parse("2024-01-05T10:11:12 Z").is_nan());
        assert!(date_parse("2024-01-05T1:11").is_nan());
        assert!(date_parse("2024-02-32").is_nan());
        // Six-digit years, to the ends of the time range.
        assert_eq!(date_parse("+275760-09-13"), 8.64e15);
        assert_eq!(date_parse("+275760-09-13T00:00:00+01:00"), 8_639_999_996_400_000.0);
        assert!(date_parse("+275760-09-13T00:00:00.001Z").is_nan());
        assert_eq!(date_parse("-271821-04-20"), -8.64e15);
        assert_eq!(date_parse("-271821-04-20T00:00:00Z"), -8.64e15);
        assert!(date_parse("-271821-04-19T23:59:59.999Z").is_nan());
        assert!(date_parse("-000000-01-01T00:00:00Z").is_nan());
    }

    #[test]
    fn parses_the_legacy_forms_like_bun() {
        assert_eq!(date_parse("Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"), 0.0);
        assert_eq!(date_parse("Fri, 05 Jan 2024 10:11:12 GMT+0530"), 1_704_429_672_000.0);
        assert_eq!(date_parse("Fri, 05 Jan 2024 10:11:12 UTC+05:30"), 1_704_429_672_000.0);
        assert_eq!(date_parse("Fri, 05 Jan 2024 10:11:12 GMT-8"), 1_704_478_272_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:11:12 PST"), 1_704_478_272_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:11:12 EDT"), 1_704_463_872_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00 UT"), 1_704_448_800_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00 Z"), 1_704_448_800_000.0);
        assert_eq!(date_parse("Mon Jan 5 2024 10:00 GMT-08:00"), 1_704_477_600_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00 GMT-0800 (PST)"), 1_704_477_600_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00 GMT (comment (nested)) "), 1_704_448_800_000.0);
        assert_eq!(date_parse("Jan 5, 2024, 10:00:00 AM GMT"), 1_704_448_800_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:11 pm GMT"), 1_704_492_660_000.0);
        assert_eq!(date_parse("Jan 5 2024 12:00 am GMT"), 1_704_412_800_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00:00.1234 GMT"), 1_704_448_800_123.0);
        assert_eq!(date_parse("Jan 5 2024 10:: GMT"), 1_704_448_800_000.0);
        assert_eq!(date_parse("12:00 Jan 5 2024 GMT"), 1_704_456_000_000.0);
        assert_eq!(date_parse("Sat, 01-Jan-2000 08:00:00 GMT"), 946_713_600_000.0);
        assert_eq!(date_parse("Tuesday, 09-Nov-99 23:12:40 GMT"), 942_189_160_000.0);
        assert_eq!(date_parse("2024/01/05 10:00 GMT"), 1_704_448_800_000.0);
        assert_eq!(date_parse("01/05/2024 GMT"), 1_704_412_800_000.0);
        assert_eq!(date_parse("2024-01-05 10:11:12Z"), 1_704_449_472_000.0);
        // Two-digit years: 0-49 are 20xx, 50-99 are 19xx.
        assert_eq!(date_parse("5 January 49 10:00 GMT"), 2_493_453_600_000.0);
        assert_eq!(date_parse("5 January 50 10:00 GMT"), -630_770_400_000.0);
        assert_eq!(date_parse("5 January 99 10:00 GMT"), 915_530_400_000.0);
        // An offset's minutes are not range-checked, and its hours may run long.
        assert_eq!(date_parse("Jan 5 2024 10:00 GMT+0099"), 1_704_442_860_000.0);
        assert_eq!(date_parse("Jan 5 2024 10:00 GMT+123:"), 1_704_006_000_000.0);
        // A later zone word wins over an offset.
        assert_eq!(date_parse("Jan 5 2024 10:00 +05:30 GMT"), 1_704_448_800_000.0);
        // Any word starting with a month's three letters names it: "junk" is June.
        assert_eq!(date_parse("Jan 5 2024 10:00 GMT junk"), 1_717_581_600_000.0);
        assert!(date_parse("Jan 5 2024 10:00 CET").is_nan());
        assert!(date_parse("Jan 5 2024 13:00 pm GMT").is_nan());
        assert!(date_parse("1234567890").is_nan());
        assert!(date_parse("13").is_nan());
    }

    #[test]
    fn reads_white_space_and_nul_like_bun() {
        // A no-break space is a space; a vertical tab only in a string with a character past Latin-1.
        assert_eq!(date_parse("Jan\u{a0}5\u{a0}2024 GMT"), 1_704_412_800_000.0);
        assert!(date_parse("Jan 5 2024 10:20:30\u{b}GMT").is_nan());
        assert_eq!(date_parse("Jan 5 2024 10:20:30\u{b}GMT(\u{100})"), 1_704_450_030_000.0);
        // NUL ends the text.
        assert!(same(date_parse("Jan 1 2024\u{0}garbage"), date_parse("Jan 1 2024")));
    }

    #[test]
    fn fills_in_missing_fields_like_bun() {
        // Each pair is read in the same (local) time zone, so they agree in any zone.
        let pairs = [
            ("0", "2000-01-01T00:00:00"),
            ("1", "2001-01-01T00:00:00"),
            ("12", "2001-12-01T00:00:00"),
            ("32", "2032-01-01T00:00:00"),
            ("Dec 25", "2001-12-25T00:00:00"),
            ("Feb 29", "2001-03-01T00:00:00"),
            ("January29 2024", "2024-01-29T00:00:00"),
            ("2024-001", "2024-01-01T00:00:00"),
            ("2024-12-", "2024-12-01T00:00:00"),
            ("2024-1-5", "2024-01-05T00:00:00"),
            ("2024-01-05 10:11", "2024-01-05T10:11:00"),
            ("275760-09-13", "+275760-09-13T00:00:00"),
            ("10000-01-01", "+010000-01-01T00:00:00"),
            ("-000000 Jan 1 2000", "2000-01-01T00:00:00"),
        ];
        for (legacy, iso) in pairs {
            assert!(same(date_parse(legacy), date_parse(iso)), "{legacy}");
        }
        assert!(date_parse("2001-12-25T00:00:00").is_finite());
        assert!(date_parse("+010000-01-01T00:00:00").is_finite());
    }

    #[test]
    fn a_wall_clock_time_in_a_gap_or_repeated_takes_the_earlier_offset() {
        // A zone with Los Angeles' 2024 transitions: PDT from 2024-03-10T10:00Z, PST again from 2024-11-03T09:00Z.
        let los_angeles = |utc: i64| if (1_710_064_800..1_730_624_400).contains(&utc) { -7 * 3600 } else { -8 * 3600 };
        let utc_of = |wall: i64| wall - former_offset_seconds(wall, los_angeles);
        // Bun under TZ=America/Los_Angeles: 02:30 and 03:30 on 2024-03-10 are both 10:30Z.
        assert_eq!(utc_of(1_710_037_800), 1_710_066_600);
        assert_eq!(utc_of(1_710_041_400), 1_710_066_600);
        assert_eq!(utc_of(1_710_035_999), 1_710_064_799);
        // 01:30 on 2024-11-03 is its first occurrence, 08:30Z; 02:30 is 10:30Z.
        assert_eq!(utc_of(1_730_597_400), 1_730_622_600);
        assert_eq!(utc_of(1_730_601_000), 1_730_629_800);
        // Lord Howe's half-hour shifts: +11:00 from 2024-10-05T15:30Z, +10:30 from 2024-04-06T15:00Z.
        let lord_howe = |utc: i64| if (1_712_415_600..1_728_142_200).contains(&utc) { 37_800 } else { 39_600 };
        let utc_of = |wall: i64| wall - former_offset_seconds(wall, lord_howe);
        // Bun under TZ=Australia/Lord_Howe: 2024-10-06T02:15 is 15:45Z, 2024-04-07T01:45 is 14:45Z.
        assert_eq!(utc_of(1_728_180_900), 1_728_143_100);
        assert_eq!(utc_of(1_712_454_300), 1_712_414_700);
        assert_eq!(utc_of(1_712_455_200), 1_712_417_400);
    }

    #[test]
    fn equivalent_years_match_webkit() {
        assert_eq!(equivalent_year(2024), 2024);
        assert_eq!(equivalent_year(2008), 2008);
        for year in [-271_821, -1, 0, 1900, 2100, 275_760] {
            let equivalent = equivalent_year(year);
            assert!((2008..=2037).contains(&equivalent));
            let leap = |y: i64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            assert_eq!(leap(equivalent), leap(year));
            let weekday = |y: i64| (days_from_year_month(y, 0) + 4).rem_euclid(7);
            assert_eq!(weekday(equivalent), weekday(year));
        }
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

    #[test]
    fn strings_escape_as_serde_json_does() {
        let mut text: String = (0u8..0x80).map(char::from).collect();
        text.push_str("é€😀\u{2028}\u{2029}\u{7f}\u{80}\u{9f}ab\"c\\");
        for sample in [text.as_str(), "", "plain", "\"", "\\", "\u{1}x", "x\u{1f}"] {
            let value = Json::String(sample.to_string());
            assert_eq!(json_stringify(&value), serde_json::to_string(&value).unwrap(), "{sample:?}");
            let object = serde_json::json!({ sample: 1 });
            assert_eq!(json_stringify(&object), serde_json::to_string(&object).unwrap(), "{sample:?}");
        }
    }

    #[test]
    fn integers_print_as_number_to_string_does() {
        let edges = [0i64, 1, -1, 42, 9_007_199_254_740_991, -9_007_199_254_740_991, 9_007_199_254_740_992, i64::MAX, i64::MIN];
        for integer in edges {
            let value = Json::Number(Number::from(integer));
            assert_eq!(json_stringify(&value), number_to_string(integer as f64), "{integer}");
        }
        assert_eq!(json_stringify(&Json::Number(Number::from(u64::MAX))), number_to_string(u64::MAX as f64));
    }
}
