//! Date helpers the server shares with the client: `src/common/utils/date.ts`.
//! "Local" means the process time zone (`TZ`), as in the Bun backend.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::JsDate;

pub const ONE_HOUR: f64 = 1000.0 * 60.0 * 60.0;
pub const ONE_DAY: f64 = 1000.0 * 60.0 * 60.0 * 24.0;
pub const TWO_WEEKS: f64 = ONE_DAY * 14.0;
pub const THIRTY_DAYS: f64 = ONE_DAY * 30.0;

static BARE_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

/// `new LocalDate(text)`: same as `Date`, but a date string without a time
/// part is read as midnight local time rather than UTC.
pub fn local_date(text: &str) -> JsDate {
    if BARE_DATE.is_match(text) {
        JsDate::parse(&format!("{text}T00:00:00"))
    } else {
        JsDate::parse(text)
    }
}

/// `getDateString(date)`: `YYYY-MM-DD` of the local day. An invalid date
/// yields `NaN-NaN-NaN`, as the TypeScript does.
pub fn get_date_string(date: JsDate) -> String {
    if !date.is_valid() {
        return "NaN-NaN-NaN".to_string();
    }
    format!("{}-{:02}-{:02}", date.get_full_year(), date.get_month() + 1, date.get_date())
}

/// `getSquashedDateString(date)`: `YYYYMMDD` of the local day.
pub fn get_squashed_date_string(date: JsDate) -> String {
    if !date.is_valid() {
        return "NaNNaNNaN".to_string();
    }
    format!("{}{:02}{:02}", date.get_full_year(), date.get_month() + 1, date.get_date())
}

/// `getDateTimeString(text)`: `YYYY-MM-DDT00:00:00`; a string that already has a time part is kept.
pub fn get_date_time_string(date_string: &str) -> String {
    if date_string.contains('T') {
        date_string.to_string()
    } else {
        format!("{date_string}T00:00:00")
    }
}

/// `getDateTimeString(date)` for a `Date`.
pub fn get_date_time_string_of(date: JsDate) -> String {
    get_date_time_string(&get_date_string(date))
}

/// `getYearMonthString(date)`: `YYYY-MM` of the local day.
pub fn get_year_month_string(date: JsDate) -> String {
    if !date.is_valid() {
        return "NaN-NaN".to_string();
    }
    format!("{}-{:02}", date.get_full_year(), date.get_month() + 1)
}

static CALENDAR_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());

/// Whether `value` is a `YYYY-MM-DD` day that exists on the calendar.
pub fn is_calendar_date(value: &str) -> bool {
    let Some(captures) = CALENDAR_DATE.captures(value) else { return false };
    let part = |i: usize| captures[i].parse::<i64>().unwrap_or(0);
    let (year, month, day) = (part(1), part(2), part(3));
    let date = JsDate::from_utc(year, month - 1, day, 0, 0, 0, 0);
    date.get_utc_full_year() == year && date.get_utc_month() == month - 1 && date.get_utc_date() == day
}

static SNAPSHOT_ID_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-(\d{4})(\d{2})(\d{2})$").unwrap());

/// The calendar day a snapshot id encodes, or `None` when the id is not `<…>-<YYYYMMDD>`.
pub fn date_from_snapshot_id(id: &str) -> Option<String> {
    SNAPSHOT_ID_DATE.captures(id).map(|c| format!("{}-{}-{}", &c[1], &c[2], &c[3]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_dates() {
        assert!(is_calendar_date("2024-02-29"));
        assert!(!is_calendar_date("2026-02-30"));
        assert!(!is_calendar_date("2026-13-01"));
        assert!(!is_calendar_date("2026-1-01"));
        assert!(!is_calendar_date("2026-01-01T00:00:00"));
    }

    #[test]
    fn snapshot_ids() {
        assert_eq!(date_from_snapshot_id("acct-20260105").as_deref(), Some("2026-01-05"));
        assert_eq!(date_from_snapshot_id("acct-2026"), None);
    }

    #[test]
    fn date_time_strings() {
        assert_eq!(get_date_time_string("2026-01-05"), "2026-01-05T00:00:00");
        assert_eq!(get_date_time_string("2026-01-05T10:00:00"), "2026-01-05T10:00:00");
    }
}
