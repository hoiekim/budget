import { createHash } from "crypto";
import { InvestmentTransactionSubtype, InvestmentTransactionType } from "plaid";
import { JSONInvestmentTransaction } from "common";
import type { DailyClose } from "../daily-closes";
import type { HoldingSnapshot } from "../postgres/repositories";
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
  if (!fitsKind(kind, row)) {
    return { status: "decide", reason: `The figures point the other way from a ${KIND_LABELS[kind]}` };
  }
  return { status: "write", kind };
};

export const KIND_LABELS: Record<ImportKind, string> = {
  contribution: "contribution",
  dividend: "dividend reinvestment",
  fee: "fee",
  withdrawal_out: "withdrawal",
  withdrawal_kept: "withdrawal",
  rollover_in: "rollover",
};

/**
 * Whether a row's figures move the way a kind does: both positive when shares
 * arrive, both negative when they leave. A row that disagrees (a reversed
 * contribution, a fee refund, or an amount and shares of opposite signs) is not
 * written as that kind with its signs dropped.
 */
export const fitsKind = (kind: ImportKind, row: Pick<StatementRow, "amount" | "shares">): boolean =>
  KIND_SPECS[kind].sharesArrive ? row.amount > 0 && row.shares > 0 : row.amount < 0 && row.shares < 0;

/** The choices a decision row offers: the kinds its figures fit, and skipping it. */
export const allowedDecisions = (row: Pick<StatementRow, "amount" | "shares">): Decision[] => [
  ...(Object.keys(KIND_SPECS) as ImportKind[]).filter((kind) => fitsKind(kind, row)),
  "skip",
];

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
  /**
   * How far apart the trust's unit price over the public fund's adjusted close
   * must be across the rows, after allowing each row the rounding in its own
   * figures: the smallest the highest ratio can be over the largest the lowest
   * can be, minus one.
   */
  spread: number | null;
  message?: string;
  /** The closes couldn't be fetched yet; the same request may succeed shortly. */
  retryable?: boolean;
}

const DEFAULT_SHARE_ROUNDING = 0.0005;
const AMOUNT_ROUNDING = 0.005;
/**
 * The most a single row's rounding may move its unit price and still be
 * measured. Past it the row can't confirm anything against a 1.5% band, and
 * an uncapped allowance would let coarse figures (whole shares, say) pass
 * drift the check can't see.
 */
const MAX_ROW_ALLOWANCE = 0.0025;
/** One measured row gives no spread at all, so it confirms nothing. */
const MIN_MEASURED_ROWS = 2;

/**
 * Restating is only sound while the trust's unit price stays a fixed multiple
 * of the public fund's dividend-adjusted close, so the rows about to be written
 * are measured against it, with the rows already imported from it. A
 * statement gives shares to a few decimals, so each row counts as the range
 * of ratios its rounded figures allow, and the check asks whether one
 * multiple fits all of them within the band. Rows whose rounding alone moves
 * the unit price more than `MAX_ROW_ALLOWANCE` aren't measured, and fewer
 * than two measured rows is a refusal, not a pass.
 */
export const checkRestatement = (
  rows: Pick<StatementRow, "date" | "amount" | "shares" | "shareRounding">[],
  bars: DailyClose[],
  ticker: string,
): RestatementCheck => {
  let highestLow = 0;
  let lowestHigh = Infinity;
  let measured = 0;
  for (const row of rows) {
    const bar = closeOnOrBefore(bars, row.date);
    if (!bar) return { ok: false, spread: null, message: `No ${ticker} close on or just before ${row.date}` };
    const units = Math.abs(row.shares);
    const dollars = Math.abs(row.amount);
    const rounding = row.shareRounding ?? DEFAULT_SHARE_ROUNDING;
    if (!units || !dollars || rounding / units + AMOUNT_ROUNDING / dollars > MAX_ROW_ALLOWANCE) continue;
    highestLow = Math.max(highestLow, (dollars - AMOUNT_ROUNDING) / (units + rounding) / bar.adjustedClose);
    lowestHigh = Math.min(lowestHigh, (dollars + AMOUNT_ROUNDING) / (units - rounding) / bar.adjustedClose);
    measured++;
  }
  if (measured < MIN_MEASURED_ROWS) {
    return {
      ok: false,
      spread: null,
      message: `Too few rows give shares precisely enough to check the restatement (${measured} of ${rows.length})`,
    };
  }
  const spread = Math.max(0, highestLow / lowestHigh - 1);
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
  /** On a row that needs a decision: the choices its figures allow. */
  allowedDecisions?: Decision[];
}

export interface FundSummary {
  investment: string;
  mapping: FundMapping | null;
  newRows: number;
  restatement?: RestatementCheck;
  /** Entered positions on the mapped holding that the transactions, after this import, don't explain. */
  positionGaps?: PositionGap[];
  /** Whether those positions are being replaced with the transactions' figures rather than kept. */
  replacePositions?: boolean;
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
  closeErrors?: Map<string, { message: string; retryable?: boolean }>;
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
    const allowed = allowedDecisions(row);
    const decided = { ...base, needsDecision, allowedDecisions: allowed };
    const decision = decisions[id];
    if (decision === "skip") return { ...decided, status: "skip", reason: "Skipped by you" };
    if (decision && allowed.includes(decision)) return { ...decided, status: "new", kind: decision as ImportKind };
    return { ...decided, status: "decide", reason: classification.reason };
  });

  const blockers: string[] = [];
  const undecided = planned.filter((r) => r.status === "decide").length;
  if (undecided) {
    blockers.push(undecided === 1 ? "1 row needs a decision" : `${undecided} rows need a decision`);
  }

  const fundNames = Array.from(new Set(rows.map((r) => r.investment)));
  const funds: FundSummary[] = fundNames.map((investment) => {
    const mapping = mappings.get(investment) ?? null;
    const toWrite = rows.filter((r, i) => r.investment === investment && planned[i].status === "new");
    // The rows written now, and the ones this statement already wrote.
    const measured = rows.filter(
      (r, i) =>
        r.investment === investment &&
        (planned[i].status === "new" || (planned[i].status === "imported" && classifyRow(r).status === "write")),
    );
    const summary: FundSummary = { investment, mapping, newRows: toWrite.length };
    if (mapping?.restated && toWrite.length) {
      const ticker = mapping.ticker_symbol ?? "";
      const bars = closes.get(investment);
      const closeError = input.closeErrors?.get(investment);
      summary.restatement = !ticker
        ? { ok: false, spread: null, message: "A restated fund needs a security with a ticker" }
        : bars?.length
          ? checkRestatement(measured, bars, ticker)
          : {
              ok: false,
              spread: null,
              message: closeError?.message ?? `No ${ticker} closes for the statement's dates`,
              retryable: closeError?.retryable,
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
 * gone. Every month after the first movement through `throughMonth` gets the
 * position it opened with, dated the 1st, including months that also moved
 * shares and months after the position closed. Writing all of them, rather
 * than only the empty months, means a later run that adds a movement rewrites
 * every 1st it affects instead of leaving an earlier run's figure behind.
 */
export const getMonthOpeningPositions = (
  positions: Map<string, Position>,
  throughMonth: string,
): { date: string; position: Position }[] => {
  const dates = Array.from(positions.keys()).sort();
  if (!dates.length) return [];
  const opening: { date: string; position: Position }[] = [];
  let i = 0;
  let last: Position | undefined;
  for (let month = addMonth(dates[0].slice(0, 7)); month <= throughMonth; month = addMonth(month)) {
    const first = `${month}-01`;
    while (i < dates.length && dates[i] < first) last = positions.get(dates[i++]);
    if (last && !positions.has(first)) opening.push({ date: first, position: last });
  }
  return opening;
};

const squash = (date: string) => date.replaceAll("-", "");

/**
 * Snapshots this import derives carry their own id prefix, so a later run can
 * tell them from snapshots someone entered (the Add Holding form writes
 * `holding-<account>-<security>-<YYYYMMDD>`) and rewrite only its own.
 */
export const DERIVED_SNAPSHOT_PREFIX = "plan-holding-";

const QUANTITY_EPSILON = 1e-6;
const MONEY_EPSILON = 0.005;

export interface StoredHoldingSnapshot {
  snapshot_id: string;
  /** YYYY-MM-DD */
  date: string;
  quantity: number;
  cost_basis: number | null;
  institution_price: number | null;
}

/** A position someone entered that the transactions don't account for. */
export interface PositionGap {
  date: string;
  stored: number;
  explained: number;
}

export interface HoldingPlan {
  gaps: PositionGap[];
  /** Snapshots whose stored values differ from what they should be, or that don't exist yet. */
  writes: HoldingSnapshot[];
  /** Derived snapshots on days that no longer get one. */
  stale: string[];
  /** The holding's position at its latest snapshot, for the holdings row. */
  latest: { date: string; position: Position } | null;
}

const positionOn = (positions: Map<string, Position>, dates: string[], date: string): Position | undefined => {
  let found: Position | undefined;
  for (const d of dates) {
    if (d > date) break;
    found = positions.get(d);
  }
  return found;
};

/**
 * What a holding's snapshots should be, from every live share movement on it.
 *
 * A snapshot someone entered (an Add Holding position, an edited quantity) may
 * hold shares no transaction explains. Each one that does is reported as a
 * gap. By default the gap is kept: the entered snapshot stands, and from its
 * date on the derived position is its quantity plus the movements since, so
 * the import adds to it rather than replacing it. With `replace`, entered
 * snapshots are rewritten to the transactions' figures.
 *
 * Derived snapshots go on every day that moved shares or has an entered
 * snapshot, and on the 1st of every month after that through `throughMonth`.
 * Only snapshots whose values change are written.
 */
export const planHolding = (input: {
  account_id: string;
  security_id: string;
  movements: Pick<JSONInvestmentTransaction, "date" | "type" | "quantity" | "amount" | "price">[];
  stored: StoredHoldingSnapshot[];
  throughMonth: string;
  replace: boolean;
}): HoldingPlan => {
  const { account_id, security_id, stored, throughMonth, replace } = input;
  const explained = getDailyPositions(input.movements);
  const explainedDates = Array.from(explained.keys()).sort();
  const at = (date: string) => positionOn(explained, explainedDates, date) ?? { quantity: 0, costBasis: 0, price: 0 };

  const entered = stored
    .filter((s) => !s.snapshot_id.startsWith(DERIVED_SNAPSHOT_PREFIX))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const enteredByDate = new Map(entered.map((s) => [s.date, s]));

  const gaps: PositionGap[] = [];
  for (const s of entered) {
    const quantity = at(s.date).quantity;
    if (Math.abs(s.quantity - quantity) > QUANTITY_EPSILON) {
      gaps.push({ date: s.date, stored: s.quantity, explained: quantity });
    }
  }

  // Prices in date order from both sources, so a day after an entered snapshot
  // and before any movement still has one.
  const prices = [
    ...Array.from(explained, ([date, p]) => ({ date, price: p.price })),
    ...entered.filter((s) => (s.institution_price ?? 0) > 0).map((s) => ({ date: s.date, price: s.institution_price! })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const priceOn = (date: string) => {
    let price = 0;
    for (const p of prices) {
      if (p.date > date) break;
      price = p.price;
    }
    return price;
  };

  const points = new Map<string, Position>();
  const pointDates = Array.from(new Set([...explainedDates, ...entered.map((s) => s.date)])).sort();
  let offset = { quantity: 0, costBasis: 0 };
  for (const date of pointDates) {
    const base = at(date);
    const own = enteredByDate.get(date);
    if (own && !replace) {
      offset = {
        quantity: own.quantity - base.quantity,
        costBasis: own.cost_basis != null ? own.cost_basis - base.costBasis : 0,
      };
    }
    points.set(date, {
      quantity: base.quantity + offset.quantity,
      costBasis: Math.max(0, base.costBasis + offset.costBasis),
      price: priceOn(date),
    });
  }

  const wanted = Array.from(points, ([date, position]) => ({ date, position }))
    .concat(getMonthOpeningPositions(points, throughMonth))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const storedById = new Map(stored.map((s) => [s.snapshot_id, s]));
  const produced = new Set<string>();
  const writes: HoldingSnapshot[] = [];
  for (const { date, position } of wanted) {
    const own = enteredByDate.get(date);
    if (own && !replace) continue;
    const snapshot_id = own ? own.snapshot_id : `${DERIVED_SNAPSHOT_PREFIX}${account_id}-${security_id}-${squash(date)}`;
    produced.add(snapshot_id);
    const current = storedById.get(snapshot_id);
    const unchanged =
      current &&
      current.date === date &&
      Math.abs(current.quantity - position.quantity) <= QUANTITY_EPSILON &&
      Math.abs((current.cost_basis ?? 0) - position.costBasis) <= MONEY_EPSILON &&
      Math.abs((current.institution_price ?? 0) - position.price) <= QUANTITY_EPSILON;
    if (unchanged) continue;
    writes.push({
      snapshot_id,
      // Noon UTC is the same calendar day in every US time zone; midnight
      // reads as the previous day, and so the previous month, west of UTC.
      snapshot_date: `${date}T12:00:00Z`,
      holding_account_id: account_id,
      holding_security_id: security_id,
      quantity: position.quantity,
      cost_basis: position.costBasis,
      institution_price: position.price,
      institution_value: position.quantity * position.price,
    });
  }

  const stale = stored
    .filter((s) => s.snapshot_id.startsWith(DERIVED_SNAPSHOT_PREFIX) && !produced.has(s.snapshot_id))
    .map((s) => s.snapshot_id);

  return { gaps, writes, stale, latest: wanted.length ? wanted[wanted.length - 1] : null };
};
