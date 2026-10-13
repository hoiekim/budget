import { AccountType } from "plaid";
import { ItemProvider, JSONAccount, JSONHolding, getSquashedDateString } from "common";
import {
  MaskedUser,
  InvTxModel,
  investmentTransactionsTable,
  INVESTMENT_TRANSACTION_ID,
  USER_ID,
  getAccount,
  getItem,
  getInvestmentTransactions,
  getHoldingSnapshots,
  getPlanFundMappings,
  savePlanFundMappings,
  searchSecuritiesById,
  upsertHoldingSnapshots,
  upsertHoldings,
  withTransaction,
  backfillMonthlySecuritySnapshotsForward,
  getDailyCloses,
  logger,
} from "server";
import type { DailyClose } from "../daily-closes";
import type { HoldingSnapshot } from "../postgres/repositories";
import { parsePlanStatement } from "./parse";
import {
  buildImportPlan,
  Decision,
  FundMapping,
  ImportPlan,
  PlannedTransaction,
  getCarryForwardPositions,
  getDailyPositions,
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
 * A restated fund's closes take two calls through a gate of five a minute that
 * the benchmark lookups on the same screen also draw from, so the usual
 * five-second foreground budget fails most first previews. The result is
 * cached, so only the first preview of a fund waits.
 */
const CLOSES_QUEUE_WAIT_MS = 60_000;

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

  const closes = new Map<string, DailyClose[]>();
  const closeErrors = new Map<string, string>();
  await Promise.all(
    Array.from(mappings).map(async ([investment, mapping]) => {
      if (!mapping.restated || !mapping.ticker_symbol) return;
      const dates = parsed.rows.filter((r) => r.investment === investment).map((r) => r.date);
      if (!dates.length) return;
      const result = await getDailyCloses(
        mapping.ticker_symbol,
        shiftDate(dates[0], -CLOSES_LEAD_DAYS),
        dates[dates.length - 1],
        { maxWaitMs: CLOSES_QUEUE_WAIT_MS },
      );
      if (result.success) closes.set(investment, result.data);
      else closeErrors.set(investment, result.message);
    }),
  );

  const existingIds = await getExistingIds(user, getRowIds(account.account_id, parsed.rows));

  const plan = buildImportPlan({
    account_id: account.account_id,
    iso_currency_code: account.balances.iso_currency_code || "USD",
    rows: parsed.rows,
    mappings,
    decisions: request.decisions,
    closes,
    closeErrors,
    existingIds,
  });

  return { ok: true, account, mappings, preview: { ...plan, parseErrors: parsed.errors } };
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

/**
 * Writes a holding snapshot for each day the statement moved shares and for
 * each month since with no movement, then the current-holdings row, through
 * the same repository calls the Add Holding form uses. Positions come from
 * every live transaction on the holding, not only the statement's, so rows
 * written by anything else are counted. The holdings row is left alone when a
 * later snapshot already exists.
 */
const refreshHoldings = async (
  user: MaskedUser,
  account_id: string,
  statementDates: Map<string, Set<string>>,
) => {
  if (!statementDates.size) return;
  const transactions = await getInvestmentTransactions(user, { account_id });
  const thisMonth = new Date().toISOString().slice(0, 7);

  for (const [security_id, dates] of statementDates) {
    const positions = getDailyPositions(transactions.filter((t) => t.security_id === security_id));
    const dated = Array.from(dates)
      .filter((date) => positions.has(date))
      .map((date) => ({ date, position: positions.get(date)! }))
      .concat(getCarryForwardPositions(positions, thisMonth))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const snapshots: HoldingSnapshot[] = dated.map(({ date, position }) => ({
      snapshot_id: `holding-${account_id}-${security_id}-${getSquashedDateString(new Date(`${date}T12:00:00Z`))}`,
      // Noon UTC is the same calendar day in every US time zone; midnight
      // reads as the previous day, and so the previous month, west of UTC.
      snapshot_date: `${date}T12:00:00Z`,
      holding_account_id: account_id,
      holding_security_id: security_id,
      quantity: position.quantity,
      cost_basis: position.costBasis,
      institution_price: position.price,
      institution_value: position.quantity * position.price,
    }));
    if (!snapshots.length) continue;
    await upsertHoldingSnapshots(user, snapshots);

    const latest = snapshots[snapshots.length - 1];
    const latestDate = dated[dated.length - 1].date;
    const existing = await getHoldingSnapshots(user, { account_id, security_id });
    if (existing.some((s) => s.snapshot_date.slice(0, 10) > latestDate)) continue;
    const holding: JSONHolding = {
      holding_id: `${account_id}-${security_id}`,
      account_id,
      security_id,
      quantity: latest.quantity ?? 0,
      cost_basis: latest.cost_basis ?? null,
      institution_price: latest.institution_price ?? 0,
      institution_price_as_of: latestDate,
      institution_value: latest.institution_value ?? 0,
      iso_currency_code: null,
      unofficial_currency_code: null,
    };
    await upsertHoldings(user, [holding]);
  }
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

  await withTransaction(async (client) => {
    await investmentTransactionsTable.upsertMany(
      preview.transactions.map((t) => toRow(user, t)),
      [],
      client,
    );
    await savePlanFundMappings(user, account_id, usedMappings, client);
  });

  const statementDates = new Map<string, Set<string>>();
  for (const row of preview.rows) {
    if (row.status !== "new" && row.status !== "imported") continue;
    const security_id = mappings.get(row.investment)?.security_id;
    if (!security_id) continue;
    const dates = statementDates.get(security_id) ?? new Set<string>();
    dates.add(row.date);
    statementDates.set(security_id, dates);
  }
  await refreshHoldings(user, account_id, statementDates);

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
