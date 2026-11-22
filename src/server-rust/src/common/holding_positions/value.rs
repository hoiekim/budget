//! What JavaScript makes of loosely typed JSON, for logic ported operator by
//! operator: a figure that should be a number may be `null` or missing, a
//! `Map` may be keyed by `undefined`, `<` orders text by UTF-16 code unit and
//! `Math.max` answers NaN for a NaN. `None` is `undefined` throughout.
//!
//! It has no TypeScript file of its own. The holding positions, the share
//! movement shape and the plan statement are all written with it, so that a
//! row the database or a client left a hole in gets the answer the
//! TypeScript gives.

use std::borrow::Cow;
use std::cmp::Ordering;

use anyhow::anyhow;

use crate::js::{self, Json, Obj};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// JavaScript's `WhiteSpace` and `LineTerminator`: what `trim()` strips,
/// `\s` matches and `Number()` ignores around a number. Unlike Rust's
/// `char::is_whitespace` it has U+FEFF and lacks U+0085.
pub(crate) fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// The order `<` and a comparator-less `sort()` put two strings in: by
/// UTF-16 code unit, which differs from Rust's code point order once a
/// character past U+FFFF meets one in U+E000..U+FFFF.
pub(crate) fn compare_text(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `String(value)`, and what a template literal writes.
pub(crate) fn to_text(value: Option<&Json>) -> String {
    value.map(js::to_js_string).unwrap_or_else(|| "undefined".to_string())
}

/// An element as `Array.prototype.join` writes it: nothing for `null` and `undefined`.
pub(crate) fn join_text(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => String::new(),
        Some(value) => js::to_js_string(value),
    }
}

/// A value the TypeScript calls a string method on. On anything but a string
/// that call throws a `TypeError`, which is the error here; `what` names the
/// value in it.
pub(crate) fn text<'a>(value: Option<&'a Json>, what: &str) -> anyhow::Result<&'a str> {
    match value {
        Some(Json::String(text)) => Ok(text),
        other => Err(anyhow!("{what} is not a string: {}", to_text(other))),
    }
}

/// `value === text`.
pub(crate) fn is_text(value: Option<&Json>, text: &str) -> bool {
    matches!(value, Some(Json::String(value)) if value == text)
}

/// `value ?? …` takes the right-hand side.
pub(crate) fn nullish(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::Null))
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

fn radix_digits(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
    }
    // Exact up to 128 bits, then rounded once, as the literal's value is.
    match u128::from_str_radix(digits, radix) {
        Ok(value) => value as f64,
        Err(_) => digits.chars().fold(0.0, |sum, c| sum * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64),
    }
}

/// `Number(text)`: the whole text must be one numeric literal; empty is 0.
pub(crate) fn text_to_number(text: &str) -> f64 {
    let literal = trim(text);
    if literal.is_empty() {
        return 0.0;
    }
    let bytes = literal.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            return radix_digits(&literal[2..], radix);
        }
    }
    let unsigned = literal.strip_prefix(['+', '-']).unwrap_or(literal);
    if unsigned == "Infinity" {
        return if literal.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    // Digits with an optional fraction and exponent; a digit on at least one side of the point.
    let digits = |from: usize| unsigned.as_bytes()[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let whole = digits(0);
    let mut end = whole;
    let mut fraction = 0;
    if unsigned.as_bytes().get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        end += 1 + fraction;
    }
    if whole + fraction == 0 {
        return f64::NAN;
    }
    if matches!(unsigned.as_bytes().get(end), Some(b'e') | Some(b'E')) {
        let sign = usize::from(matches!(unsigned.as_bytes().get(end + 1), Some(b'+') | Some(b'-')));
        let exponent = digits(end + 1 + sign);
        if exponent == 0 {
            return f64::NAN;
        }
        end += 1 + sign + exponent;
    }
    if end != unsigned.len() {
        return f64::NAN;
    }
    literal.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)`, the conversion arithmetic and `<` apply to an operand.
pub(crate) fn to_number(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => text_to_number(text),
        // An array or object goes through its text: `[]` is 0, `[5]` is 5, `{}` is NaN.
        Some(other) => text_to_number(&js::to_js_string(other)),
    }
}

/// `value === number`: a number, and that one. NaN is equal to nothing.
pub(crate) fn is_number(value: Option<&Json>, number: f64) -> bool {
    matches!(value, Some(Json::Number(value)) if value.as_f64() == Some(number))
}

/// `Math.max(a, b)`: NaN if either is, and +0 over -0.
pub(crate) fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is, and -0 under +0.
pub(crate) fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// A figure as JavaScript holds it in memory: the number (NaN and the
/// infinities included, which JSON cannot write), or the `null` or
/// `undefined` a row had in its place. Arithmetic reads it with
/// [`Num::value`]; an object written from it gets [`Num::json`], so a
/// missing figure stays missing and a `null` one stays `null`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Num {
    Undefined,
    Null,
    Value(f64),
}

impl Num {
    /// The figure a row holds under a key. Anything that is not a number,
    /// `null` or missing is read as the number arithmetic would make of it.
    pub(crate) fn of(value: Option<&Json>) -> Num {
        match value {
            None => Num::Undefined,
            Some(Json::Null) => Num::Null,
            other => Num::Value(to_number(other)),
        }
    }

    /// `Number(figure)`: NaN for `undefined`, 0 for `null`.
    pub(crate) fn value(self) -> f64 {
        match self {
            Num::Undefined => f64::NAN,
            Num::Null => 0.0,
            Num::Value(value) => value,
        }
    }

    pub(crate) fn is_null(self) -> bool {
        matches!(self, Num::Null)
    }

    /// The figure as `JSON.stringify` writes it into an object: left out when
    /// `undefined`, `null` for NaN and the infinities.
    pub(crate) fn json(self) -> Option<Json> {
        match self {
            Num::Undefined => None,
            Num::Null => Some(Json::Null),
            Num::Value(value) => Some(js::num(value)),
        }
    }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/// The text `<` compares an operand as, when it is one: a string, or an
/// object or array through its `toString()`.
fn comparison_text(value: Option<&Json>) -> Option<Cow<'_, str>> {
    match value {
        Some(Json::String(text)) => Some(Cow::Borrowed(text.as_str())),
        Some(other @ (Json::Array(_) | Json::Object(_))) => Some(Cow::Owned(js::to_js_string(other))),
        _ => None,
    }
}

/// How `<` and its kin order two values: text against text by code unit,
/// anything else as numbers. `None` where a NaN makes every comparison false.
pub(crate) fn compare(a: Option<&Json>, b: Option<&Json>) -> Option<Ordering> {
    match (comparison_text(a), comparison_text(b)) {
        (Some(a), Some(b)) => Some(compare_text(&a, &b)),
        _ => to_number(a).partial_cmp(&to_number(b)),
    }
}

/// `a < b`.
pub(crate) fn lt(a: Option<&Json>, b: Option<&Json>) -> bool {
    compare(a, b) == Some(Ordering::Less)
}

/// `a > b`.
pub(crate) fn gt(a: Option<&Json>, b: Option<&Json>) -> bool {
    compare(a, b) == Some(Ordering::Greater)
}

/// `a <= b`.
pub(crate) fn le(a: Option<&Json>, b: Option<&Json>) -> bool {
    matches!(compare(a, b), Some(Ordering::Less | Ordering::Equal))
}

/// `a < b ? -1 : a > b ? 1 : 0`, the comparators' building block.
pub(crate) fn three_way(a: Option<&Json>, b: Option<&Json>) -> f64 {
    match compare(a, b) {
        Some(Ordering::Less) => -1.0,
        Some(Ordering::Greater) => 1.0,
        _ => 0.0,
    }
}

/// `first || second()` between two comparators' answers.
pub(crate) fn or_else(first: f64, second: impl FnOnce() -> f64) -> f64 {
    if first != 0.0 && !first.is_nan() {
        first
    } else {
        second()
    }
}

// ---------------------------------------------------------------------------
// Map keys and sorting
// ---------------------------------------------------------------------------

/// A value as a `Map` key or `Set` member, which tell `null`, `undefined`
/// and the text `"null"` apart. An object, which JavaScript keys by
/// identity, is keyed by its JSON here.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Key {
    Undefined,
    Null,
    Bool(bool),
    /// The bits of the number, with -0 folded into 0.
    Number(u64),
    Text(String),
    Other(String),
}

impl Key {
    pub(crate) fn of(value: Option<&Json>) -> Key {
        match value {
            None => Key::Undefined,
            Some(Json::Null) => Key::Null,
            Some(Json::Bool(b)) => Key::Bool(*b),
            Some(Json::Number(n)) => Key::Number((n.as_f64().unwrap_or(f64::NAN) + 0.0).to_bits()),
            Some(Json::String(text)) => Key::Text(text.clone()),
            Some(other) => Key::Other(js::json_stringify(other)),
        }
    }

    pub(crate) fn text(text: &str) -> Key {
        Key::Text(text.to_string())
    }

    /// The value the key was made from.
    pub(crate) fn value(&self) -> Option<Json> {
        match self {
            Key::Undefined => None,
            Key::Null => Some(Json::Null),
            Key::Bool(b) => Some(Json::Bool(*b)),
            Key::Number(bits) => Some(js::num(f64::from_bits(*bits))),
            Key::Text(text) => Some(Json::String(text.clone())),
            Key::Other(json) => Some(js::json_parse(json).unwrap_or(Json::Null)),
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Key::Text(text) => Some(text),
            _ => None,
        }
    }
}

/// `array.sort(comparator)`, as JavaScriptCore runs it (`arrayStableSort` in
/// its `StableSort.h`): insertion sort under 8 elements, otherwise Powersort
/// over natural runs (each short run extended to 64 by insertion), merged with
/// galloping. Any stable sort gives the same order for a consistent
/// comparator; this one also asks the same questions in the same order, so
/// it gives the same order for one that is not (rows with a `null` where a
/// date belongs compare equal to everything). A comparator's answer counts
/// as "less" when it is below zero; NaN is not.
pub(crate) fn sort_by<T: Clone>(items: &mut [T], comparator: impl Fn(&T, &T) -> f64) {
    let less = |a: &T, b: &T| comparator(a, b) < 0.0;
    let len = items.len();
    if len < SORT_RUN_CUTOFF {
        insertion_sort(items, 0, len, 0, &less);
        return;
    }
    let mut work = items.to_vec();
    let mut min_gallop = MIN_GALLOP;
    let mut stack: Vec<(usize, usize, u32)> = Vec::new();
    let (mut begin, mut end) = (0, sorted_run(items, 0, &less));
    while end + 1 < len {
        let next_begin = end + 1;
        let next_end = sorted_run(items, next_begin, &less);
        let power = merge_power(begin, next_begin, next_end, len);
        while let Some(&(below_begin, below_end, below_power)) = stack.last() {
            if below_power <= power {
                break;
            }
            stack.pop();
            merge_runs(&mut work, items, below_begin, below_end + 1, begin, end + 1, &less, &mut min_gallop);
            items[below_begin..=end].clone_from_slice(&work[below_begin..=end]);
            begin = below_begin;
        }
        stack.push((begin, end, power));
        (begin, end) = (next_begin, next_end);
    }
    while let Some((below_begin, below_end, _)) = stack.pop() {
        merge_runs(&mut work, items, below_begin, below_end + 1, begin, end + 1, &less, &mut min_gallop);
        items[below_begin..=end].clone_from_slice(&work[below_begin..=end]);
        begin = below_begin;
    }
}

/// Below this many elements the sort is insertion alone; a natural run
/// shorter than it is extended by insertion.
const SORT_RUN_CUTOFF: usize = 8;
/// How long insertion makes a short run.
const SORT_FORCED_RUN: usize = 64;
const MIN_GALLOP: usize = 7;

/// Binary insertion of `items[from + sorted + 1..to]` into the sorted
/// `items[from..=from + sorted]`.
fn insertion_sort<T: Clone>(items: &mut [T], from: usize, to: usize, sorted: usize, less: &impl Fn(&T, &T) -> bool) {
    for i in from + sorted + 1..to {
        let value = items[i].clone();
        let (mut left, mut right) = (0, i - from);
        while left < right {
            let middle = (left + right) / 2;
            if less(&value, &items[from + middle]) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        items[from + left..=i].rotate_right(1);
    }
}

/// The last index of the ascending run at `begin`: a strictly descending one
/// is reversed in place.
fn natural_run<T>(items: &mut [T], begin: usize, less: &impl Fn(&T, &T) -> bool) -> usize {
    let mut end = begin;
    if end + 1 >= items.len() {
        return end;
    }
    let descending = less(&items[end + 1], &items[end]);
    end += 1;
    while end + 1 < items.len() && less(&items[end + 1], &items[end]) == descending {
        end += 1;
    }
    if descending {
        items[begin..=end].reverse();
    }
    end
}

/// The last index of the sorted run at `begin`: its natural run, extended
/// to [`SORT_FORCED_RUN`] by insertion when shorter than [`SORT_RUN_CUTOFF`],
/// then by whatever already follows in order.
fn sorted_run<T: Clone>(items: &mut [T], begin: usize, less: &impl Fn(&T, &T) -> bool) -> usize {
    let mut end = natural_run(items, begin, less);
    if end - begin < SORT_RUN_CUTOFF {
        let size = SORT_FORCED_RUN.min(items.len() - begin);
        insertion_sort(items, begin, begin + size, end - begin, less);
        end = begin + size - 1;
    }
    while end + 1 < items.len() && !less(&items[end + 1], &items[end]) {
        end += 1;
    }
    end
}

/// Powersort's node power of the boundary between the runs
/// `[left, middle - 1]` and `[middle, right]` of `len` elements.
fn merge_power(left: usize, middle: usize, right: usize, len: usize) -> u32 {
    let n1 = (middle - left) as u128;
    let n2 = (right - middle + 1) as u128;
    let a = ((left as u128) * 2 + n1) << 62;
    let b = ((middle as u128) * 2 + n2) << 62;
    let len = len as u128;
    (((a / len) ^ (b / len)) as u64).leading_zeros()
}

/// The first position in `items[base..base + len]` that `key` goes before,
/// searched outward from `hint`: after every element less than it.
fn gallop_left<T>(key: &T, items: &[T], base: usize, len: usize, hint: usize, less: &impl Fn(&T, &T) -> bool) -> usize {
    let (mut last, mut offset) = (0, 1);
    if less(&items[base + hint], key) {
        let max = len - hint;
        while offset < max && less(&items[base + hint + offset], key) {
            last = offset;
            offset = (offset * 2 + 1).min(max);
        }
        last += hint;
        offset += hint;
    } else {
        let max = hint + 1;
        while offset < max && !less(&items[base + hint - offset], key) {
            last = offset;
            offset = (offset * 2 + 1).min(max);
        }
        // One before `base` when the search reached its start, as the unsigned arithmetic of the original wraps.
        (last, offset) = (hint.wrapping_sub(offset), hint - last);
    }
    last = last.wrapping_add(1);
    while last < offset {
        let middle = last + (offset - last) / 2;
        if less(&items[base + middle], key) {
            last = middle + 1;
        } else {
            offset = middle;
        }
    }
    offset
}

/// The last position in `items[base..base + len]` that `key` goes at,
/// searched outward from `hint`: after every element it is not less than.
fn gallop_right<T>(key: &T, items: &[T], base: usize, len: usize, hint: usize, less: &impl Fn(&T, &T) -> bool) -> usize {
    let (mut last, mut offset) = (0, 1);
    if less(key, &items[base + hint]) {
        let max = hint + 1;
        while offset < max && less(key, &items[base + hint - offset]) {
            last = offset;
            offset = (offset * 2 + 1).min(max);
        }
        // One before `base` when the search reached its start, as the unsigned arithmetic of the original wraps.
        (last, offset) = (hint.wrapping_sub(offset), hint - last);
    } else {
        let max = len - hint;
        while offset < max && !less(key, &items[base + hint + offset]) {
            last = offset;
            offset = (offset * 2 + 1).min(max);
        }
        last += hint;
        offset += hint;
    }
    last = last.wrapping_add(1);
    while last < offset {
        let middle = last + (offset - last) / 2;
        if less(key, &items[base + middle]) {
            offset = middle;
        } else {
            last = middle + 1;
        }
    }
    offset
}

/// Merges the adjacent sorted runs `src[left..left_end]` and
/// `src[right..right_end]` into the same places of `dst`, galloping once one
/// side keeps winning. `min_gallop` carries over from merge to merge.
#[allow(clippy::too_many_arguments)]
fn merge_runs<T: Clone>(
    dst: &mut [T],
    src: &[T],
    left: usize,
    left_end: usize,
    right: usize,
    right_end: usize,
    less: &impl Fn(&T, &T) -> bool,
    min_gallop: &mut usize,
) {
    if left == left_end || right == right_end {
        dst[left..right_end].clone_from_slice(&src[left..right_end]);
        return;
    }
    // The left run's leading elements that the right run's first doesn't go before are already in place.
    let skip_left = gallop_right(&src[right], src, left, left_end - left, 0, less);
    dst[left..left + skip_left].clone_from_slice(&src[left..left + skip_left]);
    let mut left = left + skip_left;
    if left == left_end {
        dst[right..right_end].clone_from_slice(&src[right..right_end]);
        return;
    }
    // And so are the right run's trailing elements that the left run's last goes before.
    let right_len = right_end - right;
    let skip_right = right_len - gallop_left(&src[left_end - 1], src, right, right_len, right_len - 1, less);
    dst[right_end - skip_right..right_end].clone_from_slice(&src[right_end - skip_right..right_end]);
    let right_end = right_end - skip_right;
    if right == right_end {
        dst[left..left_end].clone_from_slice(&src[left..left_end]);
        return;
    }

    let mut right = right;
    let mut out = left;
    'merge: loop {
        // One element at a time until one side wins `min_gallop` times running.
        let (mut left_wins, mut right_wins) = (0, 0);
        while left_wins < *min_gallop && right_wins < *min_gallop {
            if right >= right_end || left >= left_end {
                break 'merge;
            }
            if less(&src[right], &src[left]) {
                dst[out] = src[right].clone();
                right += 1;
                right_wins += 1;
                left_wins = 0;
            } else {
                dst[out] = src[left].clone();
                left += 1;
                left_wins += 1;
                right_wins = 0;
            }
            out += 1;
        }

        // Then by galloping, while that keeps paying.
        *min_gallop += 1;
        loop {
            if *min_gallop > 1 {
                *min_gallop -= 1;
            }
            if left >= left_end || right >= right_end {
                break 'merge;
            }
            left_wins = gallop_right(&src[right], src, left, left_end - left, 0, less);
            dst[out..out + left_wins].clone_from_slice(&src[left..left + left_wins]);
            out += left_wins;
            left += left_wins;
            dst[out] = src[right].clone();
            out += 1;
            right += 1;
            if left >= left_end || right >= right_end {
                break 'merge;
            }
            right_wins = gallop_left(&src[left], src, right, right_end - right, 0, less);
            dst[out..out + right_wins].clone_from_slice(&src[right..right + right_wins]);
            out += right_wins;
            right += right_wins;
            dst[out] = src[left].clone();
            out += 1;
            left += 1;
            if left >= left_end || right >= right_end {
                break 'merge;
            }
            if left_wins < MIN_GALLOP && right_wins < MIN_GALLOP {
                break;
            }
        }
        *min_gallop += 1;
    }
    let rest_left = left_end - left;
    dst[out..out + rest_left].clone_from_slice(&src[left..left_end]);
    out += rest_left;
    dst[out..out + right_end - right].clone_from_slice(&src[right..right_end]);
}

/// `array.sort()` with no comparator: by `String(element)` in code unit
/// order, every `undefined` last.
pub(crate) fn sort_default(items: &mut Vec<Option<Json>>) {
    let total = items.len();
    let mut keyed: Vec<(String, Json)> = items.drain(..).flatten().map(|item| (js::to_js_string(&item), item)).collect();
    keyed.sort_by(|a, b| compare_text(&a.0, &b.0));
    items.extend(keyed.into_iter().map(|(_, item)| Some(item)));
    items.resize(total, None);
}

// ---------------------------------------------------------------------------
// Object literals
// ---------------------------------------------------------------------------

/// An object literal being written. Keys keep the order they are first given
/// in, and a value that is `undefined` leaves its key out, as
/// `JSON.stringify` does.
#[derive(Default)]
pub(crate) struct Literal(Obj);

impl Literal {
    pub(crate) fn new() -> Self {
        Literal::default()
    }

    /// `key: value` for a value that is never `undefined`.
    pub(crate) fn set(mut self, key: &str, value: impl Into<Json>) -> Self {
        self.0.insert(key.to_string(), value.into());
        self
    }

    /// `key: value` for a value that may be `undefined`.
    pub(crate) fn opt(mut self, key: &str, value: Option<Json>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_string(), value);
        }
        self
    }

    /// `key: number`, written the way `JSON.stringify` writes a number.
    pub(crate) fn num(self, key: &str, value: f64) -> Self {
        self.set(key, js::num(value))
    }

    /// `...object`: every key of an object, over the ones already written.
    pub(crate) fn spread(mut self, object: &Json) -> Self {
        if let Json::Object(object) = object {
            for (key, value) in object {
                self.0.insert(key.clone(), value.clone());
            }
        }
        self
    }
}

impl From<Literal> for Json {
    fn from(literal: Literal) -> Json {
        Json::Object(literal.0)
    }
}

/// What the tests of the modules written with this share.
#[cfg(test)]
pub(crate) mod testing {
    use crate::js::{json_stringify, Json};

    /// Asserts `actual` is `expected` key for key *in the same order*, which
    /// comparing two `Json` values with `==` does not check.
    #[track_caller]
    pub(crate) fn assert_json(actual: &Json, expected: Json) {
        assert_eq!(json_stringify(actual), json_stringify(&expected));
    }

    /// `expect(actual).toBeCloseTo(expected, digits)`.
    #[track_caller]
    pub(crate) fn assert_close(actual: &Json, expected: f64, digits: i32) {
        let actual = actual.as_f64().unwrap_or(f64::NAN);
        assert!((actual - expected).abs() < 10f64.powi(-digits) / 2.0, "{actual} is not close to {expected}");
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn whitespace_is_javascripts_not_rusts() {
        assert_eq!(trim("  x\u{a0}\u{feff}"), "x");
        assert_eq!(trim("\u{2028}w\u{2029}"), "w");
        assert_eq!(trim("\u{b}v\u{c}"), "v");
        // Rust trims U+0085 and keeps U+FEFF; JavaScript does the reverse.
        assert_eq!(trim("\u{85}y\u{85}"), "\u{85}y\u{85}");
        assert_eq!(trim("\u{180e}z\u{180e}"), "\u{180e}z\u{180e}");
        assert_eq!(trim("\u{1f}u\u{1f}"), "\u{1f}u\u{1f}");
    }

    #[test]
    fn text_becomes_a_number_the_way_number_reads_it() {
        // Values printed by `String(Number(text))` under Bun.
        let cases = [
            ("\u{85}5", "NaN"),
            ("\u{feff}5", "5"),
            ("0x+5", "NaN"),
            ("0b11", "3"),
            ("0o17", "15"),
            ("5.", "5"),
            (".5", "0.5"),
            (".", "NaN"),
            ("5.e3", "5000"),
            ("1e", "NaN"),
            ("+.5e-2", "0.005"),
            ("0x", "NaN"),
            ("1_0", "NaN"),
            ("Infinity", "Infinity"),
            ("-Infinity", "-Infinity"),
            ("infinity", "NaN"),
            ("0x1fffffffffffffffff", "590295810358705700000"),
            ("-0x10", "NaN"),
            ("١٢", "NaN"),
            ("0X1F", "31"),
            ("0B1", "1"),
            ("1e400", "Infinity"),
            ("+", "NaN"),
            ("-", "NaN"),
            ("e5", "NaN"),
            ("00012", "12"),
            ("1e+5", "100000"),
            ("1E5", "100000"),
            ("\u{2028} 5 \u{2029}", "5"),
            ("\u{180e}5", "NaN"),
            ("5\u{a0}", "5"),
            ("", "0"),
            ("  ", "0"),
            ("nan", "NaN"),
            ("inf", "NaN"),
            ("-.5", "-0.5"),
            ("1e-400", "0"),
            ("12abc", "NaN"),
        ];
        for (text, expected) in cases {
            assert_eq!(js::number_to_string(text_to_number(text)), expected, "Number({text:?})");
        }
    }

    #[test]
    fn values_become_numbers_as_arithmetic_reads_them() {
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Json::Null)), 0.0);
        assert_eq!(to_number(Some(&json!(true))), 1.0);
        assert_eq!(to_number(Some(&json!(2.5))), 2.5);
        assert_eq!(to_number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(to_number(Some(&json!([]))), 0.0);
        assert_eq!(to_number(Some(&json!([5]))), 5.0);
        assert!(to_number(Some(&json!([1, 2]))).is_nan());
        assert!(to_number(Some(&json!({}))).is_nan());
    }

    #[test]
    fn max_and_min_answer_nan_for_a_nan() {
        assert!(math_max(1.0, f64::NAN).is_nan());
        assert!(math_min(f64::NAN, 1.0).is_nan());
        assert_eq!(math_max(1.0, 2.0), 2.0);
        assert_eq!(math_min(1.0, 2.0), 1.0);
        assert!(math_max(-0.0, 0.0).is_sign_positive());
        assert!(math_min(0.0, -0.0).is_sign_negative());
        assert_eq!(math_min(f64::INFINITY, 3.0), 3.0);
    }

    #[test]
    fn a_figure_keeps_what_the_row_had() {
        assert_eq!(Num::of(None).json(), None);
        assert_eq!(Num::of(Some(&Json::Null)).json(), Some(Json::Null));
        assert_eq!(Num::of(Some(&json!(1.5))).json(), Some(json!(1.5)));
        assert_eq!(Num::Value(f64::NAN).json(), Some(Json::Null));
        assert_eq!(Num::Value(f64::INFINITY).json(), Some(Json::Null));
        assert!(Num::Undefined.value().is_nan());
        assert_eq!(Num::Null.value(), 0.0);
    }

    #[test]
    fn comparison_is_text_against_text_and_numbers_otherwise() {
        let (early, late, null, five) = (json!("2026-01-02"), json!("2026-01-10"), Json::Null, json!("5"));
        assert!(lt(Some(&early), Some(&late)));
        assert!(gt(Some(&late), Some(&early)));
        assert!(le(Some(&early), Some(&early)));
        // A date against `null` or `undefined` is NaN against a number: never less, never more.
        assert!(!lt(Some(&early), Some(&null)) && !gt(Some(&early), Some(&null)) && !le(Some(&early), Some(&null)));
        assert!(!lt(None, Some(&early)) && !gt(None, Some(&early)));
        assert!(lt(Some(&null), Some(&five)));
        assert!(le(Some(&null), Some(&null)) && !le(None, None));
        assert_eq!(three_way(Some(&early), Some(&late)), -1.0);
        assert_eq!(three_way(Some(&late), Some(&early)), 1.0);
        assert_eq!(three_way(Some(&early), None), 0.0);
    }

    #[test]
    fn text_orders_by_utf16_code_unit() {
        // `["\u{1f600}", "\u{ff5e}", "\u{e000}", "a", "Z", ""].sort()` under Bun.
        let mut items: Vec<Option<Json>> =
            ["\u{1f600}", "\u{ff5e}", "\u{e000}", "a", "Z", ""].into_iter().map(|text| Some(json!(text))).collect();
        sort_default(&mut items);
        let sorted: Vec<Json> = items.into_iter().flatten().collect();
        assert_eq!(sorted, vec![json!(""), json!("Z"), json!("a"), json!("\u{1f600}"), json!("\u{e000}"), json!("\u{ff5e}")]);
        assert_eq!(compare_text("\u{1f600}", "\u{ff5e}"), Ordering::Less);
    }

    #[test]
    fn a_default_sort_goes_by_text_with_undefined_last() {
        let mut items = vec![None, Some(json!("b")), Some(Json::Null), Some(json!(10)), Some(json!(9)), None, Some(json!("a"))];
        sort_default(&mut items);
        assert_eq!(items, vec![Some(json!(10)), Some(json!(9)), Some(json!("a")), Some(json!("b")), Some(Json::Null), None, None]);
    }

    #[test]
    fn keys_tell_null_undefined_and_text_apart() {
        let keys = [Key::of(None), Key::of(Some(&Json::Null)), Key::of(Some(&json!("null"))), Key::of(Some(&json!(0)))];
        for (i, a) in keys.iter().enumerate() {
            for (j, b) in keys.iter().enumerate() {
                assert_eq!(a == b, i == j);
            }
        }
        // However a number is held, it is one key.
        assert_eq!(Key::of(Some(&json!(-0.0))), Key::of(Some(&json!(0))));
        assert_eq!(Key::of(Some(&json!(5.0))), Key::of(Some(&json!(5))));
        assert_eq!(Key::of(Some(&json!(2.5))).value(), Some(json!(2.5)));
        assert_eq!(Key::of(None).value(), None);
        assert_eq!(Key::text("a").as_str(), Some("a"));
    }

    #[test]
    fn the_sort_is_stable_and_takes_an_inconsistent_comparator() {
        let mut rows = vec![("b", 1), ("a", 1), ("c", 0), ("d", 1), ("e", 0)];
        sort_by(&mut rows, |a, b| f64::from(a.1 - b.1));
        assert_eq!(rows, vec![("c", 0), ("e", 0), ("b", 1), ("a", 1), ("d", 1)]);

        let mut numbers: Vec<i32> = (0..50).rev().collect();
        sort_by(&mut numbers, |a, b| f64::from(a - b));
        assert_eq!(numbers, (0..50).collect::<Vec<_>>());

        // NaN for every pair: nothing moves.
        let mut same = vec![3, 1, 2];
        sort_by(&mut same, |_, _| f64::NAN);
        assert_eq!(same, vec![3, 1, 2]);
    }

    /// Indices in the order Bun's `sort` leaves rows keyed by `keys`, a
    /// `null` key comparing equal to everything.
    fn sort_with_null_keys(keys: &[Option<i32>]) -> Vec<usize> {
        let mut rows: Vec<(usize, Option<i32>)> = keys.iter().copied().enumerate().collect();
        sort_by(&mut rows, |a, b| match (a.1, b.1) {
            (Some(a), Some(b)) => f64::from(a - b),
            _ => 0.0,
        });
        rows.into_iter().map(|(i, _)| i).collect()
    }

    #[test]
    fn an_inconsistent_comparator_leaves_the_order_javascriptcore_does() {
        // Printed by Bun for the same rows.
        let keys = [5, 3, -1, 1, 9, -1, 2, 8, 7, -1, 4, 6, 0, -1, 3, 3, 1, -1, 9, 2].map(|k| (k >= 0).then_some(k));
        assert_eq!(sort_with_null_keys(&keys), [12, 3, 16, 19, 1, 14, 15, 10, 0, 2, 11, 8, 4, 5, 6, 7, 9, 13, 17, 18]);

        // Long enough for runs to be merged, with galloping.
        let keys: Vec<Option<i32>> = (0..100).map(|i| (i % 13 != 5).then_some((i * 37) % 101)).collect();
        let expected = [
            0, 71, 41, 11, 82, 52, 22, 93, 63, 33, 3, 74, 14, 85, 55, 25, 66, 36, 6, 77, 47, 17, 88, 58, 28, 99, 69, 39, 9, 80, 50,
            20, 91, 61, 1, 72, 42, 12, 53, 23, 94, 64, 34, 4, 75, 45, 86, 56, 97, 67, 37, 7, 78, 89, 81, 92, 32, 2, 5, 15, 26, 48, 59,
            29, 40, 10, 51, 21, 62, 73, 43, 13, 84, 54, 24, 95, 65, 46, 16, 27, 98, 68, 8, 18, 35, 38, 49, 19, 30, 31, 44, 57, 60, 70,
            76, 79, 83, 87, 90, 96,
        ];
        assert_eq!(sort_with_null_keys(&keys), expected);
    }

    #[test]
    fn a_literal_leaves_undefined_out_and_spreads_over_what_is_written() {
        let literal = Literal::new().set("id", "x").opt("gone", None).spread(&json!({ "b": 1, "id": "y" })).num("n", 2.0).num("nan", f64::NAN);
        testing::assert_json(&literal.into(), json!({ "id": "y", "b": 1, "n": 2, "nan": null }));
    }

    #[test]
    fn a_string_method_on_anything_else_is_an_error() {
        assert_eq!(text(Some(&json!("abc")), "x").unwrap(), "abc");
        assert!(text(None, "x").is_err());
        assert!(text(Some(&Json::Null), "x").is_err());
        assert!(text(Some(&json!(5)), "x").is_err());
        assert!(is_text(Some(&json!("buy")), "buy") && !is_text(None, "buy") && !is_text(Some(&json!("sell")), "buy"));
        assert_eq!(join_text(Some(&Json::Null)), "");
        assert_eq!(to_text(None), "undefined");
        assert_eq!(to_text(Some(&Json::Null)), "null");
    }
}
