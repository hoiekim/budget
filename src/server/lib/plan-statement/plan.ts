import { createHash } from "crypto";
import { InvestmentTransactionSubtype, InvestmentTransactionType } from "plaid";
import { JSONInvestmentTransaction } from "common";
import type { DailyClose } from "../daily-closes";
import type { StatementRow } from "./parse";

export type ImportKind =
  | "contribution"
  | "dividend"
  | "fee"
  | "withdrawal_out"
  | "withdrawal_kept"
  | "rollover_in";

export type Decision = ImportKind | "skip";

export const DECISIONS: Decision[] = [
  "contribution",
  "dividend",
  "fee",
  "withdrawal_out",
  "withdrawal_kept",
  "rollover_in",
  "skip",
];

interface KindSpec {
  sharesArrive: boolean;
  subtype: InvestmentTransactionSubtype;
  name: string;
  /** The cash row beside the share movement, for money crossing the account boundary. */
  cash: { subtype: InvestmentTransactionSubtype; name: string; moneyArrives: boolean } | null;
}

export const KIND_SPECS: Record<ImportKind, KindSpec> = {
  contribution: {
    sharesArrive: true,
    subtype: InvestmentTransactionSubtype.Contribution,
    name: "Buy (contribution)",
    cash: { subtype: InvestmentTransactionSubtype.Contribution, name: "Contribution", moneyArrives: true },
  },
  dividend: {
    sharesArrive: true,
    subtype: InvestmentTransactionSubtype.DividendReinvestment,
    name: "Buy (dividend reinvestment)",
    cash: { subtype: InvestmentTransactionSubtype.Dividend, name: "Dividend", moneyArrives: true },
  },
  fee: {
    sharesArrive: false,
    subtype: InvestmentTransactionSubtype.ManagementFee,
    name: "Sell (fee)",
    cash: { subtype: InvestmentTransactionSubtype.ManagementFee, name: "Fee", moneyArrives: false },
  },
  withdrawal_out: {
    sharesArrive: false,
    subtype: InvestmentTransactionSubtype.Sell,
    name: "Sell (withdrawal)",
    cash: { subtype: InvestmentTransactionSubtype.Withdrawal, name: "Withdrawal", moneyArrives: false },
  },
  withdrawal_kept: {
    sharesArrive: false,
    subtype: InvestmentTransactionSubtype.Sell,
    name: "Sell (withdrawal)",
    cash: null,
  },
  rollover_in: {
    sharesArrive: true,
    subtype: InvestmentTransactionSubtype.Buy,
    name: "Buy (rollover in)",
    cash: { subtype: InvestmentTransactionSubtype.Transfer, name: "Rollover in", moneyArrives: true },
  },
};

export type Classification =
  | { status: "write"; kind: ImportKind }
  | { status: "skip"; reason: string }
  | { status: "decide"; reason: string };

/**
 * What a statement row writes, from its label alone. Anything the rules don't
 * name is left to the user; a guessed label would put wrong rows in the account.
 */
export const classifyRow = (row: Pick<StatementRow, "label" | "amount" | "shares">): Classification => {
  const label = row.label.toLowerCase().replace(/\s+/g, " ").trim();
  if (row.amount === 0 && row.shares === 0) return { status: "skip", reason: "No amount or shares" };

  let kind: ImportKind | null = null;
  if (/^contributions?$/.test(label)) kind = "contribution";
  else if (/^dividends?$/.test(label)) kind = "dividend";
  else if (/\b(advisor|advisory|consultant|consulting)\b.*\bfees?\b/.test(label)) kind = "fee";
  else if (label === "conversion balance") kind = "rollover_in";
  else if (/^withdrawals?$/.test(label)) {
    return { status: "decide", reason: "Does this money leave the account or stay as cash?" };
  } else if (/^transfers?$/.test(label)) {
    return { status: "decide", reason: "A transfer that moves money or shares" };
  } else if (label === "change in market value") {
    if (row.shares === 0) return { status: "skip", reason: "Market value change, no shares moved" };
    return { status: "decide", reason: "A market value change that moves shares" };
  } else {
    return { status: "decide", reason: "This transaction type isn't recognized" };
  }

  if (row.shares === 0 || row.amount === 0) {
    return { status: "decide", reason: "The row is missing its amount or its shares" };
  }
  return { status: "write", kind };
};

/**
 * Deterministic ids, so importing an overlapping statement recognises the rows
 * it already wrote. Identical rows on the same day (two equal contributions)
 * are told apart by their position among the identical ones.
 */
export const getRowIds = (account_id: string, rows: StatementRow[]): string[] => {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const fingerprint = [
      account_id,
      row.date,
      row.investment,
      row.label,
      row.amount.toFixed(2),
      row.shares.toFixed(6),
    ].join("\0");
    const occurrence = seen.get(fingerprint) ?? 0;
    seen.set(fingerprint, occurrence + 1);
    const hash = createHash("sha256").update(`${fingerprint}\0${occurrence}`).digest("hex");
    return `plan-${hash.slice(0, 32)}`;
  });
};

export const getCashLegId = (id: string) => `${id}-cash`;

/** A statement date can fall on a weekend or market holiday. */
const MAX_CLOSE_LOOKBACK_DAYS = 7;
export const MAX_RESTATEMENT_SPREAD = 0.015;

export const closeOnOrBefore = (bars: DailyClose[], date: string): DailyClose | undefined => {
  let found: DailyClose | undefined;
  for (const bar of bars) {
    if (bar.date > date) break;
    found = bar;
  }
  if (!found) return undefined;
  const gapDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${found.date}T00:00:00Z`)) / 86_400_000;
  return gapDays <= MAX_CLOSE_LOOKBACK_DAYS ? found : undefined;
};

export interface RestatementCheck {
  ok: boolean;
  /** (max - min) / min of the trust's unit price over the public fund's adjusted close. */
  spread: number | null;
  message?: string;
}

/**
 * Restating is only sound while the trust's unit price stays a fixed multiple
 * of the public fund's dividend-adjusted close, so every row with a unit price
 * is measured against it.
 */
export const checkRestatement = (
  rows: Pick<StatementRow, "date" | "amount" | "shares">[],
  bars: DailyClose[],
  ticker: string,
): RestatementCheck => {
  const ratios: number[] = [];
  for (const row of rows) {
    const bar = closeOnOrBefore(bars, row.date);
    if (!bar) return { ok: false, spread: null, message: `No ${ticker} close on or just before ${row.date}` };
    if (row.amount === 0 || row.shares === 0) continue;
    ratios.push(Math.abs(row.amount / row.shares) / bar.adjustedClose);
  }
  if (!ratios.length) return { ok: false, spread: null, message: "No row carries a unit price to check" };
  const min = Math.min(...ratios);
  const spread = (Math.max(...ratios) - min) / min;
  if (spread > MAX_RESTATEMENT_SPREAD) {
    return {
      ok: false,
      spread,
      message: `Unit price drifts ${(spread * 100).toFixed(2)}% against ${ticker}, more than ${(
        MAX_RESTATEMENT_SPREAD * 100
      ).toFixed(1)}%`,
    };
  }
  return { ok: true, spread };
};

export interface FundMapping {
  security_id: string;
  restated: boolean;
  ticker_symbol: string | null;
}

export interface RestatedFrom {
  investment: string;
  units: number;
  unit_price: number;
}

export interface PlannedTransaction {
  transaction: Partial<JSONInvestmentTransaction> & {
    investment_transaction_id: string;
    account_id: string;
    date: string;
  };
  restated_from?: RestatedFrom;
}

export type RowStatus = "new" | "imported" | "skip" | "decide";

export interface PlannedRow {
  id: string;
  line: number;
  date: string;
  investment: string;
  label: string;
  amount: number;
  shares: number;
  status: RowStatus;
  kind?: ImportKind;
  reason?: string;
  /** The rules left this row to the user, whether or not they've decided yet. */
  needsDecision?: boolean;
}

export interface FundSummary {
  investment: string;
  mapping: FundMapping | null;
  newRows: number;
  restatement?: RestatementCheck;
}

export interface ImportPlan {
  rows: PlannedRow[];
  funds: FundSummary[];
  transactions: PlannedTransaction[];
  /** Why the plan can't be imported yet; empty when it can. */
  blockers: string[];
}

export interface PlanInput {
  account_id: string;
  iso_currency_code: string;
  rows: StatementRow[];
  mappings: Map<string, FundMapping>;
  decisions: Record<string, Decision>;
  /** Daily closes per restated fund, keyed by the statement's fund name. */
  closes: Map<string, DailyClose[]>;
  /** Why a restated fund's closes couldn't be fetched, keyed the same way. */
  closeErrors?: Map<string, string>;
  /** Ids already in the account, deleted ones included, so a removed row isn't brought back. */
  existingIds: Set<string>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const buildImportPlan = (input: PlanInput): ImportPlan => {
  const { account_id, iso_currency_code, rows, mappings, decisions, closes, existingIds } = input;
  const ids = getRowIds(account_id, rows);

  const planned: PlannedRow[] = rows.map((row, i) => {
    const id = ids[i];
    const base = { id, ...row };
    const classification = classifyRow(row);
    const needsDecision = classification.status === "decide";
    if (existingIds.has(id)) return { ...base, status: "imported", needsDecision };
    if (classification.status === "write") return { ...base, status: "new", kind: classification.kind };
    if (classification.status === "skip") return { ...base, status: "skip", reason: classification.reason };
    const decision = decisions[id];
    if (decision === "skip") return { ...base, status: "skip", reason: "Skipped by you", needsDecision };
    if (decision && decision in KIND_SPECS) return { ...base, status: "new", kind: decision, needsDecision };
    return { ...base, status: "decide", reason: classification.reason, needsDecision };
  });

  const blockers: string[] = [];
  const undecided = planned.filter((r) => r.status === "decide").length;
  if (undecided) {
    blockers.push(undecided === 1 ? "1 row needs a decision" : `${undecided} rows need a decision`);
  }

  const fundNames = Array.from(new Set(rows.map((r) => r.investment)));
  const funds: FundSummary[] = fundNames.map((investment) => {
    const mapping = mappings.get(investment) ?? null;
    const newRows = planned.filter((r) => r.investment === investment && r.status === "new").length;
    const summary: FundSummary = { investment, mapping, newRows };
    if (mapping?.restated) {
      const ticker = mapping.ticker_symbol ?? "";
      const bars = closes.get(investment);
      summary.restatement = !ticker
        ? { ok: false, spread: null, message: "A restated fund needs a security with a ticker" }
        : bars?.length
          ? checkRestatement(
              rows.filter((r) => r.investment === investment),
              bars,
              ticker,
            )
          : {
              ok: false,
              spread: null,
              message: input.closeErrors?.get(investment) ?? `No ${ticker} closes for the statement's dates`,
            };
    }
    return summary;
  });

  for (const fund of funds) {
    if (!fund.newRows) continue;
    if (!fund.mapping) blockers.push(`Map ${fund.investment} to a security`);
    else if (fund.restatement && !fund.restatement.ok) {
      blockers.push(`${fund.investment} can't be restated: ${fund.restatement.message}`);
    }
  }

  const transactions: PlannedTransaction[] = [];
  if (!blockers.length) {
    for (const row of planned) {
      if (row.status !== "new" || !row.kind) continue;
      const mapping = mappings.get(row.investment)!;
      const spec = KIND_SPECS[row.kind];
      const dollars = Math.abs(row.amount);
      const units = Math.abs(row.shares);

      let price: number;
      let restated_from: RestatedFrom | undefined;
      if (mapping.restated) {
        price = closeOnOrBefore(closes.get(row.investment)!, row.date)!.close;
        restated_from = { investment: row.investment, units: row.shares, unit_price: dollars / units };
      } else {
        price = dollars / units;
      }
      const quantity = (spec.sharesArrive ? 1 : -1) * (mapping.restated ? dollars / price : units);

      transactions.push({
        transaction: {
          investment_transaction_id: row.id,
          account_id,
          security_id: mapping.security_id,
          date: row.date,
          name: spec.name,
          amount: spec.sharesArrive ? round2(dollars) : -round2(dollars),
          quantity,
          price,
          iso_currency_code,
          type: spec.sharesArrive ? InvestmentTransactionType.Buy : InvestmentTransactionType.Sell,
          subtype: spec.subtype,
          source: "manual",
        },
        restated_from,
      });

      if (spec.cash) {
        transactions.push({
          transaction: {
            investment_transaction_id: getCashLegId(row.id),
            account_id,
            security_id: null,
            date: row.date,
            name: spec.cash.name,
            // Positive when money leaves the account.
            amount: spec.cash.moneyArrives ? -round2(dollars) : round2(dollars),
            quantity: 0,
            price: 0,
            iso_currency_code,
            type: InvestmentTransactionType.Cash,
            subtype: spec.cash.subtype,
            source: "manual",
          },
        });
      }
    }
  }

  return { rows: planned, funds, transactions, blockers };
};

export interface Position {
  quantity: number;
  costBasis: number;
  price: number;
}

/**
 * Position at the end of each day that moved shares, walking every live share
 * movement on the holding: the same count the holdings-vs-transactions
 * divergence check compares snapshots against. Cost basis is average cost,
 * like the client's `foldCostBasis`.
 */
export const getDailyPositions = (
  transactions: Pick<JSONInvestmentTransaction, "date" | "type" | "quantity" | "amount" | "price">[],
): Map<string, Position> => {
  const sorted = transactions
    .filter((t) => t.type === InvestmentTransactionType.Buy || t.type === InvestmentTransactionType.Sell)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const positions = new Map<string, Position>();
  let quantity = 0;
  let costBasis = 0;
  for (const t of sorted) {
    if (t.type === InvestmentTransactionType.Buy) {
      quantity += t.quantity;
      costBasis += t.amount;
    } else if (quantity > 0) {
      const sold = Math.min(Math.abs(t.quantity), quantity);
      costBasis -= (costBasis / quantity) * sold;
      quantity -= sold;
    }
    positions.set(t.date.slice(0, 10), { quantity, costBasis: Math.max(0, costBasis), price: t.price });
  }
  return positions;
};

const addMonth = (yearMonth: string) => {
  const [y, m] = yearMonth.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * Holdings are valued from the latest snapshot in each calendar month, with no
 * carry-forward, so a month with no share movement would show the holding as
 * gone. Each such month from the first movement through `throughMonth` gets the
 * position it opened with, dated the 1st.
 */
export const getCarryForwardPositions = (
  positions: Map<string, Position>,
  throughMonth: string,
): { date: string; position: Position }[] => {
  const dates = Array.from(positions.keys()).sort();
  if (!dates.length) return [];
  const monthsWithMovement = new Set(dates.map((d) => d.slice(0, 7)));
  const filled: { date: string; position: Position }[] = [];
  let i = 0;
  let last: Position | undefined;
  for (let month = dates[0].slice(0, 7); month <= throughMonth; month = addMonth(month)) {
    const first = `${month}-01`;
    while (i < dates.length && dates[i] < first) last = positions.get(dates[i++]);
    if (!monthsWithMovement.has(month) && last && last.quantity > 0) filled.push({ date: first, position: last });
  }
  return filled;
};
