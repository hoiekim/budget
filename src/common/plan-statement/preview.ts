import type { PlanFundMapping } from "../models";
import { derivePositions, EnteredPosition, Movement } from "../holding-positions";
import { parsePlanStatement } from "./parse";
import { buildImportPlan, DailyClose, Decision, FundMapping, ImportPlan, PlannedTransaction } from "./plan";

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

export interface PlanStatementPreview extends ImportPlan {
  /** Lines of the file that could not be read. */
  parseErrors: string[];
  /** The request that imports this preview, when nothing blocks it. */
  request: PlanStatementImportRequest | null;
}

export interface PreviewInput {
  account_id: string;
  iso_currency_code: string;
  csv: string;
  mappings: Map<string, FundMapping>;
  decisions: Record<string, Decision>;
  closes: Map<string, RestatementCloses>;
  /** Live transaction ids in the account. */
  existingIds: Set<string>;
  /** Funds whose entered positions are replaced by the transactions' figures. */
  replace: Set<string>;
  /** A mapped holding's live transactions and entered positions, as the client holds them. */
  holding: (security_id: string) => { movements: Movement[]; entered: EnteredPosition[] };
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

  const pending = plan.transactions.map((t) => t.transaction as Movement & { security_id?: string | null });
  const holdings: PlanStatementHolding[] = [];
  const replace: string[] = [];
  for (const fund of plan.funds) {
    if (!fund.mapping) continue;
    const { security_id } = fund.mapping;
    const replacing = input.replace.has(fund.investment);
    const held = input.holding(security_id);
    const { gaps, positions } = derivePositions({
      movements: [...held.movements, ...pending.filter((t) => t.security_id === security_id)],
      entered: held.entered,
      throughMonth: input.throughMonth,
      replace: replacing,
    });
    if (gaps.length) {
      fund.positionGaps = gaps;
      fund.replacePositions = replacing;
      if (replacing) replace.push(security_id);
    }
    const last = positions[positions.length - 1];
    if (last) {
      holdings.push({
        security_id,
        date: last.date,
        quantity: last.position.quantity,
        cost_basis: last.position.costBasis,
        price: last.position.price,
      });
    }
  }

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

  return { ...plan, parseErrors: parsed.errors, request };
};
