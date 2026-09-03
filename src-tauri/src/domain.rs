const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY: i64 = 24 * SECONDS_PER_HOUR;

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

#[cfg(test)]
mod tests {
    use super::{format_duration, utc_day_bounds};

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
}
