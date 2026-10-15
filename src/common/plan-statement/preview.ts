import { InvestmentTransactionSubtype } from "plaid";
import type { JSONInvestmentTransaction, PlanFundMapping } from "../models";
import { derivePositions, EnteredPosition, isDerivedPositionTransactionId, Movement } from "../holding-positions";
import { parsePlanStatement, StatementRow } from "./parse";
import { buildImportPlan, DailyClose, Decision, FundMapping, ImportPlan, PlannedTransaction } from "./plan";
import { getReinvestmentId, INFERRED_DIVIDEND_ID_PREFIX, planReinvestments } from "./reinvest";

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
  /** Rows already in the account, which are left as they are. */
  alreadyImported: number;
  /** Planned rows someone deleted from the account. Nothing was written; the page plans around them. */
  deleted?: string[];
}

export type RestatementCloses = { bars: DailyClose[] } | { message: string; retryable?: boolean };

/** A dividend reinvestment the import infers for a restated holding. */
export interface PlannedReinvestment {
  investment: string;
  ex_date: string;
  amount: number;
  quantity: number;
  /** Pays a written reinvestment's payout on the shares this statement's earlier rows add. */
  topUp: boolean;
}

export type HeldMovement = Movement & Partial<Pick<JSONInvestmentTransaction, "subtype">>;

export interface PlanStatementPreview extends ImportPlan {
  /** Lines of the file that could not be read. */
  parseErrors: string[];
  reinvestments: PlannedReinvestment[];
  /** A restated holding's prices are what blocks the import, so asking again may clear it. */
  retryCloses: boolean;
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
  /** Rows the import found deleted from the account, which are planned around like live ones. */
  deletedIds: Set<string>;
  /** Funds whose entered positions are replaced by the transactions' figures. */
  replace: Set<string>;
  /** The account's live transactions. */
  accountRows: AccountRow[];
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

export type AccountRow = Pick<JSONInvestmentTransaction, "investment_transaction_id" | "date">;

/**
 * The ex-dates a statement infers payouts for: after the latest plan-statement row before it (where
 * an earlier import's period ended), through its own last row. A payout between two statements
 * imported in order falls to the later one, and one an earlier import covered isn't planned again.
 */
export const inferencePeriod = (rows: Pick<StatementRow, "date">[], accountRows: AccountRow[]) => {
  const first = rows[0].date;
  let after: string | null = null;
  for (const { investment_transaction_id, date } of accountRows) {
    if (!isDerivedPositionTransactionId(investment_transaction_id)) continue;
    const day = date.slice(0, 10);
    if (day < first && (after === null || day > after)) after = day;
  }
  return { after, through: rows[rows.length - 1].date };
};

/**
 * The closes a restated fund needs: the statement's rows, the period whose payouts it infers, and
 * the account's later plan-statement rows, whose reinvestments may need a top-up.
 */
export const restatementClosesRange = (rows: Pick<StatementRow, "date">[], accountRows: AccountRow[]) => {
  const { after, through } = inferencePeriod(rows, accountRows);
  const later = accountRows
    .filter((r) => isDerivedPositionTransactionId(r.investment_transaction_id))
    .map((r) => r.date.slice(0, 10))
    .filter((date) => date > through);
  return closesRange([rows[0].date, through, ...(after ? [after] : []), ...later]);
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

  const known = new Set([...input.existingIds, ...input.deletedIds]);
  const plan = buildImportPlan({
    account_id: input.account_id,
    iso_currency_code: input.iso_currency_code,
    rows: parsed.rows,
    mappings: input.mappings,
    decisions: input.decisions,
    closes,
    closeErrors,
    existingIds: known,
  });

  const asMovement = (t: PlannedTransaction) => t.transaction as HeldMovement & { security_id?: string | null };
  const { after, through } = inferencePeriod(parsed.rows, input.accountRows);
  const replacing = replacedSecurities(input.mappings, input.replace);
  const reinvestments: PlannedReinvestment[] = [];
  const reinvested = new Set<string>();
  let retryCloses = false;
  if (!plan.blockers.length) {
    const written = plan.transactions.map(asMovement);
    const writing = new Set(written.map((t) => t.investment_transaction_id!));
    const owed = Array.from(restatedHoldings(input.mappings, closes, closeErrors), ([security_id, holding]) => {
      const held = input.holding(security_id);
      const movements = [...held.movements, ...written.filter((t) => t.security_id === security_id)];
      return { security_id, held, movements, ...holding };
    }).filter(({ movements }) => movements.length > 0);
    for (const { investments, bars, message } of owed) {
      if (bars) continue;
      plan.blockers.push(`${investments.join(" / ")}: ${message}`);
      retryCloses = true;
    }
    for (const { security_id, held, movements, investments, bars } of plan.blockers.length ? [] : owed) {
      if (reportsDividends(movements)) continue;
      const planned = planReinvestments({
        account_id: input.account_id,
        security_id,
        iso_currency_code: input.iso_currency_code,
        bars: bars!,
        after,
        through,
        movements,
        entered: held.entered,
        writing,
        replace: replacing.has(security_id),
        liveIds: input.existingIds,
        existingIds: known,
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
          topUp: transaction.investment_transaction_id !== getReinvestmentId(input.account_id, security_id, transaction.date),
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
    const { gaps, positions } = positionOf(security_id, replacing.has(security_id));
    if (gaps.length) {
      fund.positionGaps = gaps;
      fund.replacePositions = replacing.has(security_id);
      if (fund.replacePositions && !replace.includes(security_id)) replace.push(security_id);
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

  return { ...plan, parseErrors: parsed.errors, reinvestments, retryCloses, request };
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
  closeErrors: Map<string, { message: string }>,
) => {
  const holdings = new Map<string, { investments: string[]; bars: DailyClose[] | null; message: string }>();
  for (const [investment, mapping] of mappings) {
    if (!mapping.restated) continue;
    const holding = holdings.get(mapping.security_id) ?? { investments: [], bars: null, message: "" };
    holding.investments.push(investment);
    holding.bars ??= closes.get(investment) ?? null;
    holding.message ||= closeErrors.get(investment)?.message ?? `No ${mapping.ticker_symbol ?? "ticker"} prices`;
    holdings.set(mapping.security_id, holding);
  }
  return holdings;
};

/** Securities whose entered positions are replaced, which any fund mapped to them can ask for. */
const replacedSecurities = (mappings: Map<string, FundMapping>, replace: Set<string>) =>
  new Set(Array.from(mappings).flatMap(([investment, m]) => (replace.has(investment) ? [m.security_id] : [])));

/**
 * Whether the plan reports this holding's dividends itself, as rows the
 * statement or an earlier import wrote, so inferring them would count them twice.
 */
const reportsDividends = (movements: HeldMovement[]) =>
  movements.some(
    (m) =>
      m.subtype === InvestmentTransactionSubtype.DividendReinvestment &&
      !(m.investment_transaction_id ?? "").startsWith(INFERRED_DIVIDEND_ID_PREFIX),
  );
