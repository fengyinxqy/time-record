const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY: i64 = 24 * SECONDS_PER_HOUR;

#[cfg(test)]
pub fn format_duration(total_seconds: i64) -> String {
    let seconds = total_seconds.max(0);
    let hours = seconds / SECONDS_PER_HOUR;
    let minutes = (seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
    let remainder = seconds % SECONDS_PER_MINUTE;

    format!("{hours:02}:{minutes:02}:{remainder:02}")
}

pub fn utc_day_bounds(date: &str, timezone_offset_hours: i32) -> Option<(i64, i64)> {
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }

    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=days_in_month).contains(&day) {
        return None;
    }

    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146097 + day_of_era - 719468;
    let utc_midnight =
        days_since_epoch * SECONDS_PER_DAY - i64::from(timezone_offset_hours) * SECONDS_PER_HOUR;

    Some((utc_midnight, utc_midnight + SECONDS_PER_DAY))
}

/// Returns the inclusive local-day range `[start, end]` as a half-open UTC
/// interval `[start_utc, end_exclusive_utc)`, or `None` if either date is
/// invalid or the start is after the end.
#[cfg(test)]
pub fn utc_range_bounds(start: &str, end: &str, timezone_offset_hours: i32) -> Option<(i64, i64)> {
    let (start_utc, _) = utc_day_bounds(start, timezone_offset_hours)?;
    let (end_utc, end_exclusive) = utc_day_bounds(end, timezone_offset_hours)?;
    if start_utc > end_utc {
        return None;
    }
    Some((start_utc, end_exclusive))
}

/// Converts an HTML `datetime-local` value into UTC seconds. The resulting
/// range includes every second in the chosen end minute.
pub fn utc_datetime_range_bounds(
    start: &str,
    end: &str,
    timezone_offset_hours: i32,
) -> Option<(i64, i64)> {
    let start_utc = utc_datetime_to_utc(start, timezone_offset_hours)?;
    let end_utc = utc_datetime_to_utc(end, timezone_offset_hours)?;
    if start_utc > end_utc {
        return None;
    }
    Some((start_utc, end_utc + SECONDS_PER_MINUTE))
}

fn utc_datetime_to_utc(value: &str, timezone_offset_hours: i32) -> Option<i64> {
    let (date, time) = value.split_once('T')?;
    let (hour, minute) = time.split_once(':')?;
    if time.matches(':').count() != 1 {
        return None;
    }
    let hour = hour.parse::<i64>().ok()?;
    let minute = minute.parse::<i64>().ok()?;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
        return None;
    }
    let (utc_midnight, _) = utc_day_bounds(date, timezone_offset_hours)?;
    Some(utc_midnight + hour * SECONDS_PER_HOUR + minute * SECONDS_PER_MINUTE)
}

#[cfg(test)]
mod tests {
    use super::{format_duration, utc_datetime_range_bounds, utc_day_bounds, utc_range_bounds};

    #[test]
    fn formats_duration_as_hours_minutes_and_seconds() {
        assert_eq!(format_duration(0), "00:00:00");
        assert_eq!(format_duration(65), "00:01:05");
        assert_eq!(format_duration(3_661), "01:01:01");
    }

    #[test]
    fn returns_utc_bounds_for_a_local_date() {
        assert_eq!(
            utc_day_bounds("2026-09-02", 8),
            Some((1_788_278_400, 1_788_364_800))
        );
    }

    #[test]
    fn returns_an_exclusive_end_for_a_multi_day_range() {
        assert_eq!(
            utc_range_bounds("2026-09-02", "2026-09-04", 8),
            Some((1_788_278_400, 1_788_537_600))
        );
    }

    #[test]
    fn converts_local_datetime_range_to_a_half_open_utc_interval() {
        assert_eq!(
            utc_datetime_range_bounds("2026-09-02T09:30", "2026-09-02T10:15", 8),
            Some((1_788_312_600, 1_788_315_360))
        );
    }

    #[test]
    fn rejects_a_reversed_range() {
        assert_eq!(utc_range_bounds("2026-09-04", "2026-09-02", 8), None);
    }

    #[test]
    fn rejects_invalid_range_dates() {
        assert_eq!(utc_range_bounds("2026-02-30", "2026-09-02", 8), None);
        assert_eq!(utc_range_bounds("not-a-date", "2026-09-02", 8), None);
    }
}
