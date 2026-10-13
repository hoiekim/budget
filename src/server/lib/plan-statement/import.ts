import { AccountType } from "plaid";
import { ItemProvider, JSONAccount } from "common";
import {
  MaskedUser,
  InvTxModel,
  investmentTransactionsTable,
  INVESTMENT_TRANSACTION_ID,
  USER_ID,
  getAccount,
  getItem,
  getPlanFundMappings,
  savePlanFundMappings,
  searchSecuritiesById,
  lockHoldingPositions,
  previewHoldingPositions,
  refreshHoldingPositions,
  withTransaction,
  backfillMonthlySecuritySnapshotsForward,
  getDailyCloses,
  peekDailyCloses,
  warmDailyCloses,
  polygon,
  polygonLookupRateLimiter,
  POLYGON_LOOKUP_SHED_MESSAGE,
  logger,
} from "server";
import type { DailyClose } from "../daily-closes";
import { parsePlanStatement, StatementRow } from "./parse";
import {
  buildImportPlan,
  Decision,
  FundMapping,
  ImportPlan,
  PlanInput,
  PlannedTransaction,
  getRowIds,
} from "./plan";

export interface PlanFundMappingRequest {
  investment: string;
  security_id: string;
  restated: boolean;
}

export interface PlanStatementRequest {
  account_id: string;
  csv: string;
  mappings: PlanFundMappingRequest[];
  decisions: Record<string, Decision>;
  /** Funds whose entered positions the user chose to replace with the transactions' figures. */
  replacePositions: string[];
}

export interface PlanStatementPreview extends ImportPlan {
  /** Lines of the file that could not be read. */
  parseErrors: string[];
}

type Prepared =
  | { ok: false; message: string }
  | {
      ok: true;
      account: JSONAccount;
      preview: PlanStatementPreview;
      mappings: Map<string, FundMapping>;
    };

/** Bars from a little before the first row, so a row dated on a holiday finds the prior close. */
const CLOSES_LEAD_DAYS = 10;

/**
 * Rows per INSERT. Each row binds 14 parameters and Postgres takes at most
 * 65,535 in one statement.
 */
const INSERT_CHUNK_ROWS = 1000;

const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const getExistingIds = async (user: MaskedUser, ids: string[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  const models = await investmentTransactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [INVESTMENT_TRANSACTION_ID]: ids }, excludeDeleted: false },
  );
  return new Set(models.map((m) => m.investment_transaction_id));
};

/**
 * The closes for one restated fund. A call that would reach the shared market
 * data gate is charged to the same per-user budget the ticker lookups use. It
 * waits only as long as any other request a person is watching; past that the
 * fetch carries on in the background and the fund comes back as still loading,
 * for the page to retry.
 */
const getRestatementCloses = async (
  user: MaskedUser,
  ticker: string,
  rows: StatementRow[],
): Promise<{ bars: DailyClose[] } | { message: string; retryable?: boolean }> => {
  const from = shiftDate(rows[0].date, -CLOSES_LEAD_DAYS);
  const to = rows[rows.length - 1].date;
  const stillLoading = { message: `Prices for ${ticker} are still loading. Retry in a minute.`, retryable: true };

  const peek = peekDailyCloses(ticker, from, to);
  if (peek === "loading") return stillLoading;
  if (peek) return peek.success ? { bars: peek.data } : { message: peek.message };

  if (polygonLookupRateLimiter.isLimited(user.user_id)) return { message: POLYGON_LOOKUP_SHED_MESSAGE };
  polygonLookupRateLimiter.consume(user.user_id);
  const result = await getDailyCloses(ticker, from, to, { maxWaitMs: polygon.FOREGROUND_QUEUE_WAIT_MS });
  if (result.success) return { bars: result.data };
  if (result.error === "rate_limited") {
    warmDailyCloses(ticker, from);
    return stillLoading;
  }
  return { message: result.message };
};

const prepare = async (user: MaskedUser, request: PlanStatementRequest): Promise<Prepared> => {
  const account = await getAccount(user, request.account_id);
  if (!account) return { ok: false, message: "Account not found." };
  const item = await getItem(user, account.item_id);
  if (account.type !== AccountType.Investment || item?.provider !== ItemProvider.MANUAL) {
    return { ok: false, message: "Plan statements can only be imported into a manual investment account." };
  }

  const parsed = parsePlanStatement(request.csv);
  if (!parsed.rows.length) {
    return { ok: false, message: parsed.errors[0] ?? "The file has no statement rows." };
  }

  const requested = new Map(request.mappings.map((m) => [m.investment, m]));
  const saved = await getPlanFundMappings(user, account.account_id);
  const chosen = new Map<string, { security_id: string; restated: boolean }>();
  for (const m of saved) chosen.set(m.investment, m);
  for (const m of requested.values()) chosen.set(m.investment, m);

  const securities = await searchSecuritiesById(Array.from(new Set([...chosen.values()].map((m) => m.security_id))));
  const tickers = new Map(securities.map((s) => [s.security_id, s.ticker_symbol]));
  const mappings = new Map<string, FundMapping>();
  for (const [investment, m] of chosen) {
    if (!tickers.has(m.security_id)) {
      if (requested.has(investment)) return { ok: false, message: `Security for ${investment} not found.` };
      continue;
    }
    mappings.set(investment, {
      security_id: m.security_id,
      restated: m.restated,
      ticker_symbol: tickers.get(m.security_id) ?? null,
    });
  }

  const input: PlanInput = {
    account_id: account.account_id,
    iso_currency_code: account.balances.iso_currency_code || "USD",
    rows: parsed.rows,
    mappings,
    decisions: request.decisions,
    closes: new Map(),
    closeErrors: new Map(),
    existingIds: await getExistingIds(user, getRowIds(account.account_id, parsed.rows)),
  };

  // Closes are fetched only for restated funds with rows still to write.
  const needed = buildImportPlan(input).funds.filter((f) => f.mapping?.restated && f.mapping.ticker_symbol && f.newRows);
  await Promise.all(
    needed.map(async ({ investment, mapping }) => {
      const rows = parsed.rows.filter((r) => r.investment === investment);
      const result = await getRestatementCloses(user, mapping!.ticker_symbol!, rows);
      if ("bars" in result) input.closes.set(investment, result.bars);
      else input.closeErrors!.set(investment, result);
    }),
  );

  const plan = buildImportPlan(input);

  // Gaps are measured against the transactions as they'll be once this
  // statement's rows are written.
  const replaced = new Set(request.replacePositions);
  const holdings = statementHoldings(plan, mappings, replaced);
  const holdingPlans = await previewHoldingPositions(
    user,
    account.account_id,
    holdings.security_ids,
    plan.transactions.map((t) => t.transaction),
    { replace: holdings.replace },
  );
  for (const fund of plan.funds) {
    const holding = fund.mapping && holdingPlans.get(fund.mapping.security_id);
    if (!holding?.gaps.length) continue;
    fund.positionGaps = holding.gaps;
    fund.replacePositions = replaced.has(fund.investment);
  }

  return { ok: true, account, mappings, preview: { ...plan, parseErrors: parsed.errors } };
};

/** The mapped holdings the statement touches, and those whose entered positions are replaced. */
const statementHoldings = (plan: ImportPlan, mappings: Map<string, FundMapping>, replaced: Set<string>) => {
  const security_ids = new Set<string>();
  const replace = new Set<string>();
  for (const fund of plan.funds) {
    const mapping = mappings.get(fund.investment);
    if (!mapping) continue;
    security_ids.add(mapping.security_id);
    if (replaced.has(fund.investment)) replace.add(mapping.security_id);
  }
  return { security_ids: Array.from(security_ids), replace: Array.from(replace) };
};

export const previewPlanStatement = async (
  user: MaskedUser,
  request: PlanStatementRequest,
): Promise<{ ok: false; message: string } | { ok: true; preview: PlanStatementPreview }> => {
  const prepared = await prepare(user, request);
  if (!prepared.ok) return prepared;
  return { ok: true, preview: prepared.preview };
};

const toRow = (user: MaskedUser, planned: PlannedTransaction) => {
  const row = InvTxModel.fromJSON(planned.transaction, user.user_id);
  if (planned.restated_from) {
    row.raw = { ...((row.raw as object | null) ?? {}), restated_from: planned.restated_from };
  }
  return row;
};

export interface PlanStatementImportResult {
  written: number;
  alreadyImported: number;
}

export const importPlanStatement = async (
  user: MaskedUser,
  request: PlanStatementRequest,
): Promise<{ ok: false; message: string } | { ok: true; result: PlanStatementImportResult }> => {
  const prepared = await prepare(user, request);
  if (!prepared.ok) return prepared;
  const { account, preview, mappings } = prepared;
  if (preview.blockers.length) return { ok: false, message: preview.blockers.join(". ") };

  const account_id = account.account_id;
  const statementFunds = new Set(preview.rows.map((r) => r.investment));
  const usedMappings = Array.from(mappings)
    .filter(([investment]) => statementFunds.has(investment))
    .map(([investment, m]) => ({ investment, security_id: m.security_id, restated: m.restated }));
  const holdings = statementHoldings(preview, mappings, new Set(request.replacePositions));
  const rows = preview.transactions.map((t) => toRow(user, t));

  await withTransaction(async (client) => {
    // Before the rows go in, so another writer of this account's holdings
    // that's waiting sees them once this commits.
    await lockHoldingPositions(client, user, account_id);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
      await investmentTransactionsTable.upsertMany(rows.slice(i, i + INSERT_CHUNK_ROWS), [], client);
    }
    await savePlanFundMappings(user, account_id, usedMappings, client);
    await refreshHoldingPositions(client, user, account_id, holdings.security_ids, { replace: holdings.replace });
  });

  const firstDates = new Map<string, string>();
  for (const t of preview.transactions) {
    const { security_id, date } = t.transaction;
    if (!security_id) continue;
    const first = firstDates.get(security_id);
    if (!first || date < first) firstDates.set(security_id, date);
  }
  backfillMonthlySecuritySnapshotsForward(
    Array.from(firstDates).map(([security_id, fromDate]) => ({ security_id, fromDate })),
  ).catch((error) => logger.error("backfillMonthlySecuritySnapshotsForward failed (plan statement)", { account_id }, error));

  return {
    ok: true,
    result: {
      written: preview.transactions.length,
      alreadyImported: preview.rows.filter((r) => r.status === "imported").length,
    },
  };
};
