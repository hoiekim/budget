//! Small shared helpers: `src/common/utils/{index,hash,math}.ts`.

use rand::Rng;

use crate::js::Json;

/// `getRandomId()`: five hex digits.
pub fn get_random_id() -> String {
    format!("{:x}", 65536 + rand::rng().random_range(0..983040u32))
}

/// A deterministic 128-bit hash as 32 hex digits, identical to the
/// TypeScript `hash128`: four FNV-1a-style passes over the string's UTF-16
/// code units.
pub fn hash128(text: &str) -> String {
    const PASSES: [(u32, u32); 4] =
        [(0x811c9dc5, 0x01000193), (0x6c62272e, 0x5bd1e995), (0x07bb0142, 0x85ebca6b), (0x9e3779b9, 0xc2b2ae35)];
    let units: Vec<u16> = text.encode_utf16().collect();
    PASSES
        .iter()
        .map(|(basis, multiplier)| {
            let mut h = *basis;
            for unit in &units {
                h = (h ^ *unit as u32).wrapping_mul(*multiplier);
            }
            h ^= h >> 16;
            format!("{h:08x}")
        })
        .collect()
}

/// A running mean: `Average` in `math.ts`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Average {
    sum: f64,
    count: f64,
}

impl Average {
    pub fn value(&self) -> f64 {
        if self.count == 0.0 {
            0.0
        } else {
            self.sum / self.count
        }
    }

    pub fn put(&mut self, value: f64) {
        self.sum += value;
        self.count += 1.0;
    }

    pub fn merge(&mut self, that: &Average) {
        self.sum += that.sum;
        self.count += that.count;
    }
}

/// `cap(value, { min, max })`.
pub fn cap(value: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    if let Some(min) = min {
        if value < min {
            return min;
        }
    }
    if let Some(max) = max {
        if value > max {
            return max;
        }
    }
    value
}

/// `clamp(n, min, max)`.
pub fn clamp(n: f64, min: f64, max: f64) -> f64 {
    n.max(min).min(max)
}

/// `isEqual(x, y)`: deep equality of two JSON values. With `partial`, `x` may
/// carry keys `y` lacks (`isSubset`).
pub fn is_equal(x: &Json, y: &Json, partial: bool) -> bool {
    match (x, y) {
        (Json::Array(a), Json::Array(b)) => {
            (partial || a.len() == b.len()) && b.iter().enumerate().all(|(i, item)| a.get(i).map(|other| is_equal(other, item, partial)).unwrap_or(false))
        }
        (Json::Object(a), Json::Object(b)) => {
            (partial || a.len() == b.len()) && b.iter().all(|(key, value)| a.get(key).map(|other| is_equal(other, value, partial)).unwrap_or(false))
        }
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        _ => x == y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash128_matches_the_typescript() {
        // Values produced by `hash128` in src/common/utils/hash.ts.
        assert_eq!(hash128(""), "811c1cd96c624b4c07bb06f99e37e78e");
        assert_eq!(hash128("abc"), "1a47f34c916f5e69d9932fe5689a01ef");
        assert_eq!(hash128("plan|2026-01-05|Vanguard 500|12.5|-3.25"), "4c686b826c558e707db4af7ba8d9a287");
        assert_eq!(hash128("日本語🔐 mixed ASCII"), "5f469689af5c6c487718bc4a737ea039");
    }

    #[test]
    fn random_ids_are_five_hex_digits() {
        for _ in 0..100 {
            let id = get_random_id();
            assert_eq!(id.len(), 5);
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }
}
