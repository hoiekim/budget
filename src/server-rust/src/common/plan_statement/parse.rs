//! `src/common/plan-statement/parse.ts`.
//!
//! A statement row (`StatementRow`) is a JSON object:
//! `{ line, date, investment, label, amount, shares, shareRounding }`, where
//! `line` is the 1-based line in the uploaded file, `date` is `YYYY-MM-DD`
//! and `shareRounding` is half a unit in the last decimal place the file gave
//! the shares to (0.0005 for "9.876"), so the true figure lies within
//! `shares ± shareRounding`.

use std::sync::LazyLock;

use regex::Regex;

use crate::common::holding_positions::value::{compare_text, is_whitespace, sort_by, text_to_number, trim, Literal};
use crate::js::{JsDate, Json};

/// What `parse_plan_statement` returns: `{ rows, errors }`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedStatement {
    /// `StatementRow`s, oldest first.
    pub rows: Vec<Json>,
    /// Lines under the header that could not be read, each naming its line.
    pub errors: Vec<String>,
}

impl ParsedStatement {
    /// The object the TypeScript returns.
    pub fn to_json(&self) -> Json {
        Literal::new().set("rows", self.rows.clone()).set("errors", self.errors.clone()).into()
    }
}

const HEADER: [&str; 5] = ["date", "investment", "transaction type", "amount", "shares/unit"];

fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if ch == ',' && !in_quotes {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields.iter().map(|field| trim(field).to_string()).collect()
}

fn is_header(fields: &[String]) -> bool {
    HEADER.iter().enumerate().all(|(i, name)| fields.get(i).is_some_and(|field| field.to_lowercase() == *name))
}

static DECIMALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.([0-9]+)").unwrap());

fn half_last_decimal(raw: &str) -> f64 {
    let decimals = DECIMALS.captures(raw).map(|captures| captures[1].len()).unwrap_or(0);
    0.5 * 10f64.powf(-(decimals as f64))
}

/// "1,234.56", "-12.3", "(12.30)" → number; anything else → NaN.
fn parse_number(raw: &str) -> f64 {
    let s: String = raw.chars().filter(|c| !matches!(c, '$' | ',') && !is_whitespace(*c)).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    let negative = s.len() >= 2 && s.starts_with('(') && s.ends_with(')');
    let n = text_to_number(if negative { &s[1..s.len() - 1] } else { &s });
    if negative {
        -n
    } else {
        n
    }
}

static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$").unwrap());

fn parse_date(raw: &str) -> Option<String> {
    let captures = DATE.captures(raw)?;
    let (m, d, y) = (&captures[1], &captures[2], &captures[3]);
    let month: i64 = m.parse().ok()?;
    let day: i64 = d.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let date = format!("{y}-{m:0>2}-{d:0>2}");
    // A day past the month's end rolls into the next month, so its day of the month comes back different.
    let check = JsDate::parse(&format!("{date}T00:00:00Z"));
    (check.is_valid() && check.get_utc_date() == day).then_some(date)
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// Reads a recordkeeper's plan-statement export:
///
///   Plan name:,…
///   Date Range,…
///   Date,Investment,Transaction Type,Amount,Shares/Unit
///   09/30/2026,EXAMPLE INDEX FUND,Contributions,"1,234.56","9.876"
///
/// Everything above the header is ignored. Rows come back oldest first.
pub fn parse_plan_statement(text: &str) -> ParsedStatement {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines = split_lines(text);
    let Some(header_index) = lines.iter().position(|line| is_header(&split_csv_line(line))) else {
        return ParsedStatement {
            rows: Vec::new(),
            errors: vec![r#"No "Date,Investment,Transaction Type,Amount,Shares/Unit" header found."#.to_string()],
        };
    };

    // Each row with its line and date, which the order goes by.
    let mut rows: Vec<(usize, String, Json)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (i, text) in lines.iter().enumerate().skip(header_index + 1) {
        let line = i + 1;
        if trim(text).is_empty() {
            continue;
        }
        let fields = split_csv_line(text);
        let field = |index: usize| fields.get(index).map(String::as_str).unwrap_or("");
        let (date_raw, investment, label, amount_raw, shares_raw) = (field(0), field(1), field(2), field(3), field(4));
        let date = parse_date(date_raw);
        let amount = parse_number(amount_raw);
        let shares = if shares_raw.is_empty() { 0.0 } else { parse_number(shares_raw) };
        let Some(date) = date.filter(|_| !investment.is_empty() && !label.is_empty() && amount.is_finite() && shares.is_finite())
        else {
            errors.push(format!("Line {line} could not be read."));
            continue;
        };
        let row = Literal::new()
            .set("line", line)
            .set("date", date.as_str())
            .set("investment", investment)
            .set("label", label)
            .num("amount", amount)
            .num("shares", shares)
            .num("shareRounding", half_last_decimal(shares_raw));
        rows.push((line, date, row.into()));
    }

    sort_by(&mut rows, |(a_line, a_date, _), (b_line, b_date, _)| {
        if a_date == b_date {
            *b_line as f64 - *a_line as f64
        } else if compare_text(a_date, b_date).is_lt() {
            -1.0
        } else {
            1.0
        }
    });
    ParsedStatement { rows: rows.into_iter().map(|(_, _, row)| row).collect(), errors }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::common::holding_positions::value::testing::assert_json;

    const STATEMENT: &str = concat!(
        "Plan name:,EXAMPLE SAVINGS PLAN\r\n",
        "Date Range,01/01/2026 - 09/30/2026\r\n",
        "\r\n",
        "Date,Investment,Transaction Type,Amount,Shares/Unit\r\n",
        "09/30/2026,EXAMPLE INDEX FUND,Contributions,\"1,234.56\",\"9.876\"\r\n",
        "09/30/2026,EXAMPLE INDEX FUND,Advisor Fee,\"-12.30\",\"-0.098\"\r\n",
        "09/15/2026,EXAMPLE TRUST,Transfers,0.00,0.000",
    );

    const HEADER_LINE: &str = "Date,Investment,Transaction Type,Amount,Shares/Unit";

    #[test]
    fn reads_the_rows_under_the_header_oldest_first_with_thousands_separators_removed() {
        let parsed = parse_plan_statement(STATEMENT);
        assert_json(
            &parsed.to_json(),
            json!({
                "rows": [
                    { "line": 7, "date": "2026-09-15", "investment": "EXAMPLE TRUST", "label": "Transfers", "amount": 0, "shares": 0, "shareRounding": 0.0005 },
                    { "line": 6, "date": "2026-09-30", "investment": "EXAMPLE INDEX FUND", "label": "Advisor Fee", "amount": -12.3, "shares": -0.098, "shareRounding": 0.0005 },
                    { "line": 5, "date": "2026-09-30", "investment": "EXAMPLE INDEX FUND", "label": "Contributions", "amount": 1234.56, "shares": 9.876, "shareRounding": 0.0005 },
                ],
                "errors": [],
            }),
        );
    }

    #[test]
    fn reports_a_row_it_cant_read_by_line_and_keeps_the_rest() {
        let text = [
            HEADER_LINE,
            "13/40/2026,EXAMPLE INDEX FUND,Contributions,10,1",
            "09/30/2026,EXAMPLE INDEX FUND,Contributions,abc,1",
            "09/29/2026,EXAMPLE INDEX FUND,Contributions,10,1",
        ]
        .join("\n");
        let parsed = parse_plan_statement(&text);
        assert_eq!(parsed.errors, ["Line 2 could not be read.", "Line 3 could not be read."]);
        let dates: Vec<&Json> = parsed.rows.iter().map(|row| &row["date"]).collect();
        assert_eq!(dates, [&json!("2026-09-29")]);
    }

    #[test]
    fn rejects_a_calendar_date_that_doesnt_exist() {
        let text = [HEADER_LINE, "02/30/2026,F,Contributions,10,1"].join("\n");
        assert_eq!(parse_plan_statement(&text).errors, ["Line 2 could not be read."]);
        let leap = [HEADER_LINE, "02/29/2024,F,Contributions,10,1", "02/29/2026,F,Contributions,10,1", "4/31/2026,F,Contributions,10,1"].join("\n");
        let parsed = parse_plan_statement(&leap);
        assert_eq!(parsed.errors, ["Line 3 could not be read.", "Line 4 could not be read."]);
        assert_eq!(parsed.rows[0]["date"], "2024-02-29");
    }

    #[test]
    fn a_file_without_the_header_is_refused() {
        let parsed = parse_plan_statement("Run Date,Action,Symbol\n01/02/2026,BUY,ABC");
        assert!(parsed.rows.is_empty());
        assert_eq!(parsed.errors, [r#"No "Date,Investment,Transaction Type,Amount,Shares/Unit" header found."#]);
    }

    #[test]
    fn records_how_finely_each_row_gives_its_shares() {
        let text = [HEADER_LINE, "01/05/2026,F,Contributions,10,2.5", "01/06/2026,F,Contributions,10,3", "1/7/2026,F,Contributions,10,"].join("\n");
        let rounding: Vec<Json> = parse_plan_statement(&text).rows.iter().map(|row| row["shareRounding"].clone()).collect();
        assert_json(&Json::Array(rounding), json!([0.05, 0.5, 0.5]));
    }

    #[test]
    fn reads_parenthesised_negatives_and_a_byte_order_mark() {
        let text = "\u{feff}Date,Investment,Transaction Type,Amount,Shares/Unit\n01/05/2026,F,Advisor Fee,\"(1,000.50)\",(2.5)";
        let parsed = parse_plan_statement(text);
        assert_json(&parsed.rows[0]["amount"], json!(-1000.5));
        assert_json(&parsed.rows[0]["shares"], json!(-2.5));
    }

    #[test]
    fn splits_fields_on_commas_outside_quotes_and_trims_them() {
        assert_eq!(split_csv_line(r#" a ,"b, c","say ""hi""",,d"e"f "#), ["a", "b, c", r#"say "hi""#, "", "def"]);
        assert_eq!(split_csv_line(""), [""]);
        // U+00A0 and U+FEFF are trimmed; U+0085 is not.
        assert_eq!(split_csv_line("\u{a0}x\u{feff},\u{85}y"), ["x", "\u{85}y"]);
    }

    #[test]
    fn lines_end_at_a_line_feed_with_or_without_a_carriage_return() {
        assert_eq!(split_lines("a\r\nb\nc\rd\r\r\n\r"), ["a", "b", "c\rd\r", "\r"]);
        assert_eq!(split_lines(""), [""]);
    }

    #[test]
    fn rows_of_one_day_come_back_last_line_first_and_the_header_may_be_in_any_case() {
        let text = "junk\nDATE, Investment ,transaction TYPE,AMOUNT,Shares/Unit,extra\n1/5/2026,F,A,$1,1\n1/5/2026,F,B,1,1\n\n1/4/2026,F,C,1,1\n";
        let parsed = parse_plan_statement(text);
        assert!(parsed.errors.is_empty());
        let rows: Vec<Json> = parsed.rows.iter().map(|row| json!([row["line"], row["label"]])).collect();
        assert_json(&Json::Array(rows), json!([[6, "C"], [4, "B"], [3, "A"]]));
    }
}
