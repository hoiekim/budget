import { AccountType, InvestmentTransactionType } from "plaid";
import {
  ItemProvider,
  JSONHolding,
  isCalendarDate,
  KIND_SPECS,
  PLAN_STATEMENT_ID_PATTERN,
  PlannedTransaction,
  PlanStatementImportRequest,
  PlanStatementImportResult,
  REINVESTED_DISTRIBUTION,
  RESTATED_FROM,
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

const SHARE_SUBTYPES = new Set<string>(Object.values(KIND_SPECS).map((spec) => spec.subtype));
const CASH_SUBTYPES = new Set<string>(
  Object.values(KIND_SPECS).flatMap((spec) => (spec.cash ? [spec.cash.subtype] : [])),
);
const MAX_CURRENCY_LENGTH = 10;

/** Which of the ids are already in the account: live, or deleted by someone. */
const getExistingIds = async (user: MaskedUser, ids: string[]): Promise<{ live: Set<string>; deleted: string[] }> => {
  const existing = { live: new Set<string>(), deleted: [] as string[] };
  if (!ids.length) return existing;
  const models = await investmentTransactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [INVESTMENT_TRANSACTION_ID]: ids }, excludeDeleted: false },
  );
  for (const m of models) {
    if (m.is_deleted) existing.deleted.push(m.investment_transaction_id);
    else existing.live.add(m.investment_transaction_id);
  }
  return existing;
};

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The row to store for a planned one, built from its checked fields alone, or
 * why it can't be stored in this account. Anything else the client sent is
 * dropped, and every row is a manual one.
 */
const toRow = (
  user: MaskedUser,
  account_id: string,
  planned: PlannedTransaction,
): { row: ReturnType<typeof InvTxModel.fromJSON> } | { problem: string } => {
  const t = planned.transaction;
  const id = t.investment_transaction_id;
  if (!PLAN_STATEMENT_ID_PATTERN.test(id)) return { problem: `${id} is not a plan statement row id` };
  if (t.account_id !== account_id) return { problem: `${id} belongs to another account` };
  if (!isCalendarDate(t.date)) return { problem: `${id} has no valid date` };
  const isCashLeg = id.endsWith("-cash");
  const typeFits = isCashLeg
    ? t.type === InvestmentTransactionType.Cash && CASH_SUBTYPES.has(t.subtype ?? "") && t.security_id === null
    : (t.type === InvestmentTransactionType.Buy || t.type === InvestmentTransactionType.Sell) &&
      SHARE_SUBTYPES.has(t.subtype ?? "") &&
      typeof t.security_id === "string";
  if (!typeFits) return { problem: `${id} has the wrong type, subtype or security` };
  if (![t.amount, t.quantity, t.price].every(isFiniteNumber)) return { problem: `${id} has a figure that isn't a number` };
  if (typeof t.name !== "string") return { problem: `${id} has an unreadable name` };
  const currency = t.iso_currency_code ?? null;
  if (currency !== null && (typeof currency !== "string" || currency.length > MAX_CURRENCY_LENGTH)) {
    return { problem: `${id} has an unreadable currency` };
  }
  const r = planned.restated_from;
  if (r && (typeof r.investment !== "string" || !isFiniteNumber(r.units) || !isFiniteNumber(r.unit_price))) {
    return { problem: `${id} has an unreadable restatement` };
  }
  const d = planned.reinvested_distribution;
  if (
    d &&
    (isCashLeg ||
      !isCalendarDate(d.ex_date) ||
      d.ex_date !== t.date ||
      ![d.cash_amount_per_share, d.shares_held].every(isFiniteNumber))
  ) {
    return { problem: `${id} has an unreadable reinvestment` };
  }

  const row = InvTxModel.fromJSON(
    {
      investment_transaction_id: id,
      account_id,
      security_id: t.security_id,
      date: t.date,
      name: t.name,
      amount: t.amount,
      quantity: t.quantity,
      price: t.price,
      iso_currency_code: currency,
      type: t.type,
      subtype: t.subtype,
      source: "manual",
    },
    user.user_id,
  );
  row.raw = r
    ? { [RESTATED_FROM]: { investment: r.investment, units: r.units, unit_price: r.unit_price } }
    : d
      ? {
          [REINVESTED_DISTRIBUTION]: {
            ex_date: d.ex_date,
            cash_amount_per_share: d.cash_amount_per_share,
            shares_held: d.shares_held,
          },
        }
      : null;
  return { row };
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

  const built = new Map<string, ReturnType<typeof InvTxModel.fromJSON>>();
  for (const planned of request.transactions) {
    const result = toRow(user, account_id, planned);
    if ("problem" in result) return { ok: false, message: result.problem };
    built.set(planned.transaction.investment_transaction_id, result.row);
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
  // The page holds only live rows, so it planned these as new: the shares and payouts it
  // derived from them are wrong. It plans again around them before anything is written.
  if (existing.deleted.length) {
    return { ok: true, result: { written: 0, alreadyImported: 0, deleted: existing.deleted } };
  }
  const rows = Array.from(built).filter(([id]) => !existing.live.has(id)).map(([, row]) => row);

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

  return { ok: true, result: { written: rows.length, alreadyImported: existing.live.size } };
};
