import { InvestmentTransactionSubtype } from "plaid";
import type { JSONInvestmentTransaction, PlanFundMapping } from "../models";
import { derivePositions, EnteredPosition, Movement } from "../holding-positions";
import { parsePlanStatement } from "./parse";
import { buildImportPlan, DailyClose, Decision, FundMapping, ImportPlan, PlannedTransaction } from "./plan";
import { getReinvestmentId, planReinvestments } from "./reinvest";

/** A holding's position after the import, for its holdings row. */
export interface PlanStatementHolding {
  security_id: string;
  /** YYYY-MM-DD of the position. */
  date: string;
  quantity: number;
  cost_basis: number | null;
  price: number;
}

/** What the import page sends: the rows it planned, and what they do to the account. */
export interface PlanStatementImportRequest {
  account_id: string;
  transactions: PlannedTransaction[];
  /** The statement's funds, saved on the account so the next statement opens with them filled in. */
  mappings: PlanFundMapping[];
  /** Securities whose entered positions are retired, so the holding follows the transactions alone. */
  replace: string[];
  holdings: PlanStatementHolding[];
}

export interface PlanStatementImportResult {
  written: number;
  /** Rows already in the account, deleted ones included, which are left as they are. */
  alreadyImported: number;
}

export type RestatementCloses = { bars: DailyClose[] } | { message: string; retryable?: boolean };

/** A dividend reinvestment the import infers for a restated holding. */
export interface PlannedReinvestment {
  investment: string;
  ex_date: string;
  amount: number;
  quantity: number;
}

export type HeldMovement = Movement & Partial<Pick<JSONInvestmentTransaction, "subtype">>;

export interface PlanStatementPreview extends ImportPlan {
  /** Lines of the file that could not be read. */
  parseErrors: string[];
  reinvestments: PlannedReinvestment[];
  /** The request that imports this preview, when nothing blocks it. */
  request: PlanStatementImportRequest | null;
}

export interface PreviewInput {
  account_id: string;
  iso_currency_code: string;
  csv: string;
  /** The statement's funds, and the account's restated funds it has no rows for. */
  mappings: Map<string, FundMapping>;
  decisions: Record<string, Decision>;
  closes: Map<string, RestatementCloses>;
  /** Live transaction ids in the account. */
  existingIds: Set<string>;
  /** Funds whose entered positions are replaced by the transactions' figures. */
  replace: Set<string>;
  /** A mapped holding's live transactions and entered positions, as the client holds them. */
  holding: (security_id: string) => { movements: HeldMovement[]; entered: EnteredPosition[] };
  /** YYYY-MM */
  throughMonth: string;
}

/** Days of closes before a restated fund's first row, so a row dated on a holiday finds the prior close. */
export const CLOSES_LEAD_DAYS = 10;

const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The range of closes a restated fund's rows need. */
export const closesRange = (dates: string[]): { from: string; to: string } => {
  const sorted = [...dates].sort();
  return { from: shiftDate(sorted[0], -CLOSES_LEAD_DAYS), to: sorted[sorted.length - 1] };
};

/**
 * Everything the import page shows for a statement, and the request that
 * imports it: the plan, each mapped holding's entered positions that the
 * transactions (after this import) don't explain, and each holding's position
 * afterwards.
 */
export const previewPlanStatement = (input: PreviewInput): PlanStatementPreview | { error: string } => {
  const parsed = parsePlanStatement(input.csv);
  if (!parsed.rows.length) return { error: parsed.errors[0] ?? "The file has no statement rows." };

  const closes = new Map<string, DailyClose[]>();
  const closeErrors = new Map<string, { message: string; retryable?: boolean }>();
  for (const [investment, result] of input.closes) {
    if ("bars" in result) closes.set(investment, result.bars);
    else closeErrors.set(investment, result);
  }

  const plan = buildImportPlan({
    account_id: input.account_id,
    iso_currency_code: input.iso_currency_code,
    rows: parsed.rows,
    mappings: input.mappings,
    decisions: input.decisions,
    closes,
    closeErrors,
    existingIds: input.existingIds,
  });

  const asMovement = (t: PlannedTransaction) => t.transaction as HeldMovement & { security_id?: string | null };
  const through = parsed.rows[parsed.rows.length - 1].date;
  const reinvestments: PlannedReinvestment[] = [];
  const reinvested = new Set<string>();
  if (!plan.blockers.length) {
    const written = plan.transactions.map(asMovement);
    for (const [security_id, { investments, bars, replace }] of restatedHoldings(input.mappings, closes, input.replace)) {
      const held = input.holding(security_id);
      const movements = [...held.movements, ...written.filter((t) => t.security_id === security_id)];
      if (reportsDividends(input.account_id, security_id, movements)) continue;
      const planned = planReinvestments({
        account_id: input.account_id,
        security_id,
        iso_currency_code: input.iso_currency_code,
        bars,
        through,
        movements,
        entered: held.entered,
        replace,
        existingIds: input.existingIds,
      });
      plan.transactions.push(...planned);
      for (const { transaction } of planned) {
        if (transaction.security_id !== security_id) continue;
        reinvested.add(security_id);
        reinvestments.push({
          investment: investments.join(" / "),
          ex_date: transaction.date,
          amount: transaction.amount!,
          quantity: transaction.quantity!,
        });
      }
    }
  }

  const pending = plan.transactions.map(asMovement);
  const holdings: PlanStatementHolding[] = [];
  const replace: string[] = [];
  const positionOf = (security_id: string, replacing: boolean) => {
    const held = input.holding(security_id);
    return derivePositions({
      movements: [...held.movements, ...pending.filter((t) => t.security_id === security_id)],
      entered: held.entered,
      throughMonth: input.throughMonth,
      replace: replacing,
    });
  };
  const pushHolding = (security_id: string, positions: ReturnType<typeof derivePositions>["positions"]) => {
    const last = positions[positions.length - 1];
    if (!last || holdings.some((h) => h.security_id === security_id)) return;
    holdings.push({
      security_id,
      date: last.date,
      quantity: last.position.quantity,
      cost_basis: last.position.costBasis,
      price: last.position.price,
    });
  };
  for (const fund of plan.funds) {
    if (!fund.mapping) continue;
    const { security_id } = fund.mapping;
    const replacing = input.replace.has(fund.investment);
    const { gaps, positions } = positionOf(security_id, replacing);
    if (gaps.length) {
      fund.positionGaps = gaps;
      fund.replacePositions = replacing;
      if (replacing && !replace.includes(security_id)) replace.push(security_id);
    }
    pushHolding(security_id, positions);
  }
  for (const security_id of reinvested) pushHolding(security_id, positionOf(security_id, false).positions);

  const statementFunds = new Set(parsed.rows.map((r) => r.investment));
  const request: PlanStatementImportRequest | null = plan.blockers.length
    ? null
    : {
        account_id: input.account_id,
        transactions: plan.transactions,
        mappings: Array.from(input.mappings)
          .filter(([investment]) => statementFunds.has(investment))
          .map(([investment, m]) => ({ investment, security_id: m.security_id, restated: m.restated })),
        replace,
        holdings,
      };

  return { ...plan, parseErrors: parsed.errors, reinvestments, request };
};

/**
 * The restated holdings the import infers dividends for, by security, since two
 * funds can be restated into one. The mappings may include the account's other
 * restated funds, which this statement has no rows for but whose shares are
 * still owed the payouts in its period.
 */
const restatedHoldings = (
  mappings: Map<string, FundMapping>,
  closes: Map<string, DailyClose[]>,
  replacing: Set<string>,
) => {
  const holdings = new Map<string, { investments: string[]; bars: DailyClose[]; replace: boolean }>();
  for (const [investment, mapping] of mappings) {
    const bars = closes.get(investment);
    if (!mapping.restated || !bars) continue;
    const holding = holdings.get(mapping.security_id) ?? { investments: [], bars, replace: false };
    holding.investments.push(investment);
    holding.replace ||= replacing.has(investment);
    holdings.set(mapping.security_id, holding);
  }
  return holdings;
};

/**
 * Whether the plan reports this holding's dividends itself, as rows the
 * statement or an earlier import wrote, so inferring them would count them twice.
 */
const reportsDividends = (account_id: string, security_id: string, movements: HeldMovement[]) =>
  movements.some(
    (m) =>
      m.subtype === InvestmentTransactionSubtype.DividendReinvestment &&
      m.investment_transaction_id !== getReinvestmentId(account_id, security_id, m.date.slice(0, 10)),
  );
