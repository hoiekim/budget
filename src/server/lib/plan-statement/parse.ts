export interface StatementRow {
  /** 1-based line in the uploaded file, for pointing the user at a row. */
  line: number;
  /** YYYY-MM-DD */
  date: string;
  investment: string;
  label: string;
  amount: number;
  shares: number;
  /**
   * Half a unit in the last decimal place the file gave the shares to, so the
   * true figure lies within `shares ± shareRounding`. 0.0005 for "9.876".
   */
  shareRounding?: number;
}

export interface ParsedStatement {
  rows: StatementRow[];
  /** Lines under the header that could not be read, each naming its line. */
  errors: string[];
}

const HEADER = ["date", "investment", "transaction type", "amount", "shares/unit"];

const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
};

const isHeader = (fields: string[]) =>
  HEADER.every((name, i) => fields[i]?.toLowerCase() === name);

const halfLastDecimal = (raw: string): number => {
  const decimals = /\.(\d+)/.exec(raw)?.[1].length ?? 0;
  return 0.5 * 10 ** -decimals;
};

/** "1,234.56", "-12.3", "(12.30)" → number; anything else → NaN. */
const parseNumber = (raw: string): number => {
  const s = raw.replace(/[$,\s]/g, "");
  if (!s) return NaN;
  const negative = /^\(.*\)$/.test(s);
  const n = Number(negative ? s.slice(1, -1) : s);
  return negative ? -n : n;
};

const parseDate = (raw: string): string | null => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) return null;
  const [, m, d, y] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const check = new Date(`${date}T00:00:00Z`);
  return check.getUTCDate() === day ? date : null;
};

/**
 * Reads a recordkeeper's plan-statement export:
 *
 *   Plan name:,…
 *   Date Range,…
 *   Date,Investment,Transaction Type,Amount,Shares/Unit
 *   09/30/2026,EXAMPLE INDEX FUND,Contributions,"1,234.56","9.876"
 *
 * Everything above the header is ignored. Rows come back oldest first.
 */
export const parsePlanStatement = (text: string): ParsedStatement => {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => isHeader(splitCsvLine(line)));
  if (headerIndex < 0) {
    return {
      rows: [],
      errors: ['No "Date,Investment,Transaction Type,Amount,Shares/Unit" header found.'],
    };
  }

  const rows: StatementRow[] = [];
  const errors: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = i + 1;
    if (!lines[i].trim()) continue;
    const [dateRaw = "", investment = "", label = "", amountRaw = "", sharesRaw = ""] =
      splitCsvLine(lines[i]);
    const date = parseDate(dateRaw);
    const amount = parseNumber(amountRaw);
    const shares = sharesRaw === "" ? 0 : parseNumber(sharesRaw);
    if (!date || !investment || !label || !Number.isFinite(amount) || !Number.isFinite(shares)) {
      errors.push(`Line ${line} could not be read.`);
      continue;
    }
    rows.push({ line, date, investment, label, amount, shares, shareRounding: halfLastDecimal(sharesRaw) });
  }

  rows.sort((a, b) => (a.date === b.date ? b.line - a.line : a.date < b.date ? -1 : 1));
  return { rows, errors };
};
