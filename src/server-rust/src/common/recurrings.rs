//! `src/common/recurrings.ts`.

use crate::common::date::get_date_string;
use crate::js::JsDate;

enum Step {
    Days(i64),
    Months(i64),
}

/// One period of each cadence as calendar arithmetic: a schedule has to land
/// on the same day of the month, unlike the detector's fractional day counts.
fn cadence_step(cadence: &str) -> Option<Step> {
    Some(match cadence {
        "weekly" => Step::Days(7),
        "biweekly" => Step::Days(14),
        "monthly" => Step::Months(1),
        "quarterly" => Step::Months(3),
        "semiannual" => Step::Months(6),
        "annual" => Step::Months(12),
        _ => return None,
    })
}

/// `periods` cadence steps after `anchor`, in local time. Month steps are
/// taken from the anchor and clamped to the target month's last day, so a
/// Jan 31 anchor yields Feb 28 then Mar 31.
fn add_cadence(anchor: JsDate, step: &Step, periods: i64) -> JsDate {
    let (year, month, day) = (anchor.get_full_year(), anchor.get_month(), anchor.get_date());
    match step {
        Step::Days(days) => JsDate::from_local_ymd(year, month, day + days * periods),
        Step::Months(months) => {
            let target_month = month + months * periods;
            let last_day_of_target = JsDate::from_local_ymd(year, target_month + 1, 0).get_date();
            JsDate::from_local_ymd(year, target_month, day.min(last_day_of_target))
        }
    }
}

/// The next date a recurring is expected on: the first cadence step after its
/// latest occurrence that falls on or after `today`. `None` for an
/// unparseable date or an unknown cadence.
pub fn get_next_recurring_date(latest: JsDate, cadence: &str, today: JsDate) -> Option<JsDate> {
    if !latest.is_valid() || !today.is_valid() {
        return None;
    }
    let step = cadence_step(cadence)?;
    let today_string = get_date_string(today);
    let mut periods = 1;
    loop {
        let next = add_cadence(latest, &step, periods);
        if get_date_string(next) >= today_string {
            return Some(next);
        }
        periods += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(year: i64, month: i64, date: i64) -> JsDate {
        JsDate::from_local_ymd(year, month - 1, date)
    }

    #[test]
    fn month_steps_clamp_to_the_month_end_without_drifting() {
        let latest = day(2026, 1, 31);
        assert_eq!(get_date_string(get_next_recurring_date(latest, "monthly", day(2026, 2, 1)).unwrap()), "2026-02-28");
        assert_eq!(get_date_string(get_next_recurring_date(latest, "monthly", day(2026, 3, 1)).unwrap()), "2026-03-31");
    }

    #[test]
    fn steps_until_today_or_later() {
        let latest = day(2026, 1, 5);
        assert_eq!(get_date_string(get_next_recurring_date(latest, "weekly", day(2026, 1, 20)).unwrap()), "2026-01-26");
        assert_eq!(get_date_string(get_next_recurring_date(latest, "biweekly", day(2026, 1, 19)).unwrap()), "2026-01-19");
        assert_eq!(get_date_string(get_next_recurring_date(latest, "annual", day(2026, 1, 6)).unwrap()), "2027-01-05");
        assert!(get_next_recurring_date(JsDate::INVALID, "weekly", day(2026, 1, 1)).is_none());
    }
}
