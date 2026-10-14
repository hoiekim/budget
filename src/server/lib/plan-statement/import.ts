import { AccountType, InvestmentTransactionType } from "plaid";
import {
  ItemProvider,
  JSONHolding,
  PLAN_STATEMENT_ID_PATTERN,
  PlannedTransaction,
  PlanStatementImportRequest,
  PlanStatementImportResult,
} from "common";
import {
  MaskedUser,
  InvTxModel,
  accountsTable,
  investmentTransactionsTable,
  INVESTMENT_TRANSACTION_ID,
  USER_ID,
  getAccount,
  getItem,
  getHoldingSnapshotsForSecurities,
  searchSecuritiesById,
  softDeleteHoldingSnapshots,
  upsertHoldingOrThrow,
  withTransaction,
  backfillMonthlySecuritySnapshotsForward,
  logger,
} from "server";

/**
 * Rows per INSERT. Each row binds 14 parameters and Postgres takes at most
 * 65,535 in one statement.
 */
const INSERT_CHUNK_ROWS = 1000;

const SHARE_TYPES = [InvestmentTransactionType.Buy, InvestmentTransactionType.Sell];

const getExistingIds = async (user: MaskedUser, ids: string[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  const models = await investmentTransactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [INVESTMENT_TRANSACTION_ID]: ids }, excludeDeleted: false },
  );
  return new Set(models.map((m) => m.investment_transaction_id));
};

/** Why a planned row can't be stored in this account, or null when it can. */
const rowProblem = (account_id: string, planned: PlannedTransaction): string | null => {
  const t = planned.transaction;
  const id = t.investment_transaction_id;
  if (!PLAN_STATEMENT_ID_PATTERN.test(id)) return `${id} is not a plan statement row id`;
  if (t.account_id !== account_id) return `${id} belongs to another account`;
  const isCashLeg = id.endsWith("-cash");
  if (isCashLeg ? t.type !== InvestmentTransactionType.Cash : !SHARE_TYPES.includes(t.type!)) {
    return `${id} has the wrong type`;
  }
  if (isCashLeg ? t.security_id !== null : typeof t.security_id !== "string") {
    return `${id} has the wrong security`;
  }
  for (const n of [t.amount, t.quantity, t.price]) {
    if (typeof n !== "number" || !Number.isFinite(n)) return `${id} has a figure that isn't a number`;
  }
  const r = planned.restated_from;
  if (r && (typeof r.investment !== "string" || !Number.isFinite(r.units) || !Number.isFinite(r.unit_price))) {
    return `${id} has an unreadable restatement`;
  }
  return null;
};

const toRow = (user: MaskedUser, planned: PlannedTransaction) => {
  const row = InvTxModel.fromJSON(planned.transaction, user.user_id);
  if (planned.restated_from) {
    row.raw = { ...((row.raw as object | null) ?? {}), restated_from: planned.restated_from };
  }
  return row;
};

export const importPlanStatement = async (
  user: MaskedUser,
  request: PlanStatementImportRequest,
): Promise<{ ok: false; message: string } | { ok: true; result: PlanStatementImportResult }> => {
  const account = await getAccount(user, request.account_id);
  if (!account) return { ok: false, message: "Account not found." };
  const item = await getItem(user, account.item_id);
  if (account.type !== AccountType.Investment || item?.provider !== ItemProvider.MANUAL) {
    return { ok: false, message: "Plan statements can only be imported into a manual investment account." };
  }
  const account_id = account.account_id;

  for (const planned of request.transactions) {
    const problem = rowProblem(account_id, planned);
    if (problem) return { ok: false, message: problem };
  }

  const security_ids = new Set<string>([
    ...request.transactions.map((t) => t.transaction.security_id).filter((id): id is string => !!id),
    ...request.mappings.map((m) => m.security_id),
    ...request.replace,
    ...request.holdings.map((h) => h.security_id),
  ]);
  const found = new Set((await searchSecuritiesById(Array.from(security_ids))).map((s) => s.security_id));
  const missing = Array.from(security_ids).find((id) => !found.has(id));
  if (missing) return { ok: false, message: `Security ${missing} not found.` };

  const existing = await getExistingIds(
    user,
    request.transactions.map((t) => t.transaction.investment_transaction_id),
  );
  const rows = request.transactions
    .filter((t) => !existing.has(t.transaction.investment_transaction_id))
    .map((t) => toRow(user, t));

  const mappings = new Map((account.plan_fund_mappings ?? []).map((m) => [m.investment, m]));
  for (const m of request.mappings) mappings.set(m.investment, m);

  await withTransaction(async (client) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
      await investmentTransactionsTable.upsertMany(rows.slice(i, i + INSERT_CHUNK_ROWS), [], client);
    }
    await accountsTable.update(
      account_id,
      {
        plan_fund_mappings: Object.fromEntries(
          Array.from(mappings.values(), ({ investment, security_id, restated }) => [
            investment,
            { security_id, restated },
          ]),
        ),
      },
      undefined,
      user.user_id,
      client,
    );
    if (request.replace.length) {
      const entered = await getHoldingSnapshotsForSecurities(user, account_id, request.replace, { client });
      await softDeleteHoldingSnapshots(user, entered.map((s) => s.snapshot_id), client);
    }
    for (const h of request.holdings) {
      const holding: JSONHolding = {
        holding_id: `${account_id}-${h.security_id}`,
        account_id,
        security_id: h.security_id,
        quantity: h.quantity,
        cost_basis: h.cost_basis,
        institution_price: h.price,
        institution_price_as_of: h.date,
        institution_value: h.quantity * h.price,
        iso_currency_code: null,
        unofficial_currency_code: null,
      };
      await upsertHoldingOrThrow(user, holding, client);
    }
  });

  const firstDates = new Map<string, string>();
  for (const { transaction } of request.transactions) {
    const { security_id, date } = transaction;
    if (!security_id) continue;
    const first = firstDates.get(security_id);
    if (!first || date < first) firstDates.set(security_id, date);
  }
  backfillMonthlySecuritySnapshotsForward(
    Array.from(firstDates).map(([security_id, fromDate]) => ({ security_id, fromDate })),
  ).catch((error) => logger.error("backfillMonthlySecuritySnapshotsForward failed (plan statement)", { account_id }, error));

  return { ok: true, result: { written: rows.length, alreadyImported: existing.size } };
};
