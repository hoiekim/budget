import {
  JSONTransaction,
  JSONRecurringLabel,
  JSONRecurringSplit,
  RecurringStatus,
  RecurringCadence,
} from "common";
import { pool } from "../client";
import {
  MaskedUser,
  QueryExecutor,
  transactionsTable,
  recurringsTable,
  USER_ID,
  RECURRING_ID,
  MERCHANT_KEY,
  MERCHANT_NAME,
  CADENCE,
  IS_INCOME,
  STATUS,
  TRANSACTION_IDS,
  TRANSACTION_ID,
  SPLITS,
  IS_DELETED,
  UPDATED,
  LABEL_BUDGET_ID,
  LABEL_CATEGORY_ID,
  LABEL_CATEGORY_CONFIDENCE,
} from "../models";
import { TRANSACTIONS, RECURRINGS, SPLIT_TRANSACTIONS } from "common/constants";

export interface Recurring {
  recurring_id: string;
  merchant_key: string;
  merchant_name: string;
  cadence: RecurringCadence;
  is_income: boolean;
  status: RecurringStatus;
  transactions: JSONTransaction[];
  /** Default budget/category its transactions take while it's confirmed.
   *  Optional on the client: recurrings cached before this field existed
   *  come back from IndexedDB without it. */
  label?: JSONRecurringLabel;
  /** Splits each charge joining it takes. Optional on the client for the
   *  same reason as `label`. */
  splits?: JSONRecurringSplit[];
  /** Bumped on every mutation (confirm/dismiss/create/auto-attach). Lets
   *  the FE reduce over a delta by `updated` instead of replacing its
   *  cache wholesale — same role `updated` plays on transaction_pairs. */
  updated?: string | null;
}

export interface GetRecurringsOptions {
  /** When true, non-renderable recurrings are INCLUDED as eviction signals.
   *  Defaults to false: a caller that just wants the current list gets
   *  active-non-dismissed rows only. */
  includeDeleted?: boolean;
  /** Delta cursor. When set, only recurrings whose `updated >= startDate`
   *  are returned. Backed by the `(user_id, updated)` composite index. */
  startDate?: string;
  /** Restrict to these recurrings — how a write route reads back the row
   *  it just changed so the writing tab can apply it without a refetch. */
  recurringIds?: string[];
}

export type RecurringResult =
  | { ok: true; recurring_id: string }
  | { ok: false; error: string };

export type RecurringConfirmResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Get all recurrings for a user. Resolves each recurring's
 * `transaction_ids` to the live transaction JSONs so the response shape
 * stays denormalized (one entry per recurring, members inline) — the same
 * contract `getTransferPairs` keeps for pairs.
 */
export const getRecurrings = async (
  user: MaskedUser,
  options: GetRecurringsOptions = {},
): Promise<Recurring[]> => {
  const allRecurrings = await recurringsTable.query(
    { [USER_ID]: user.user_id },
    {
      orderBy: RECURRING_ID,
      excludeDeleted: !options.includeDeleted,
      inFilters: options.recurringIds ? { [RECURRING_ID]: options.recurringIds } : undefined,
      dateRange: options.startDate
        ? { column: UPDATED, start: options.startDate }
        : undefined,
    },
  );

  if (allRecurrings.length === 0) return [];

  // A recurring is FE-visible only when it's active AND not user-dismissed.
  // `status='dismissed'` is the denylist signal (mirrors transfers'
  // `status='rejected'`): the engine won't re-suggest this merchant group.
  const isVisible = (r: (typeof allRecurrings)[number]) =>
    !r.is_deleted && r.status !== "dismissed";
  const visibleRecurrings = allRecurrings.filter(isVisible);

  const toEviction = (r: (typeof allRecurrings)[number]): Recurring => ({
    recurring_id: r.recurring_id,
    merchant_key: r.merchant_key,
    merchant_name: r.merchant_name,
    cadence: r.cadence,
    is_income: r.is_income,
    status: r.status,
    transactions: [],
    label: { budget_id: r.label_budget_id, category_id: r.label_category_id },
    splits: r.splits,
    updated: r.updated,
  });

  const evictions: Recurring[] = options.includeDeleted
    ? allRecurrings.filter((r) => !isVisible(r)).map(toEviction)
    : [];

  if (visibleRecurrings.length === 0) return evictions;

  const txnIds = [...new Set(visibleRecurrings.flatMap((r) => r.transaction_ids))];

  const txnModels = await transactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [TRANSACTION_ID]: txnIds } },
  );

  const txnById = new Map<string, JSONTransaction>();
  for (const m of txnModels) {
    const tx = m.toJSON();
    txnById.set(tx.transaction_id, tx);
  }

  const active: Recurring[] = [];
  for (const r of visibleRecurrings) {
    const transactions = r.transaction_ids
      .map((id) => txnById.get(id))
      .filter((t): t is JSONTransaction => !!t);
    if (transactions.length === 0) {
      // Active recurring whose members no longer resolve (all
      // soft-deleted). Under `includeDeleted` it must be evicted
      // explicitly — a delta reducer never revisits an id it isn't sent.
      if (options.includeDeleted) evictions.push(toEviction(r));
      continue;
    }
    active.push({
      recurring_id: r.recurring_id,
      merchant_key: r.merchant_key,
      merchant_name: r.merchant_name,
      cadence: r.cadence,
      is_income: r.is_income,
      status: r.status,
      transactions,
      label: { budget_id: r.label_budget_id, category_id: r.label_category_id },
      splits: r.splits,
      updated: r.updated,
    });
  }

  return [...active, ...evictions];
};

const EMPTY_LABEL: JSONRecurringLabel = { budget_id: null, category_id: null };

const isEmptyLabel = (label: JSONRecurringLabel) => !label.budget_id && !label.category_id;

const lockRecurrings = (client: QueryExecutor, userId: string) =>
  client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))`, [userId]);

/**
 * Give `transactionIds` a recurring's default label, skipping exceptions.
 * `previous` is the default they were following before this change. A
 * transaction follows the default when it is:
 *   - unlabeled (confidence NULL) or holds an engine suggestion (0 < c < 1);
 *   - confirmed (c = 1) with exactly the previous default;
 *   - category-less by choice (c = 0, what a budget-only edit or a cleared
 *     category leaves) with no budget or the previous default's budget.
 * Anything else the user chose (a different confirmed category, a move to
 * another budget) is an exception and keeps its label. An empty default
 * relabels nothing.
 */
export const applyRecurringLabel = async (
  executor: QueryExecutor,
  userId: string,
  label: JSONRecurringLabel,
  transactionIds: string[],
  previous: JSONRecurringLabel = EMPTY_LABEL,
): Promise<void> => {
  if (isEmptyLabel(label) || transactionIds.length === 0) return;
  // A budget-only default marks the category as deliberately empty (0), not
  // unlabeled (NULL): the suggestion engine only fills NULL rows, and its
  // pick would move them to whatever budget its category sits under.
  const confidence = label.category_id ? 1 : 0;
  await executor.query(
    `UPDATE ${TRANSACTIONS}
     SET ${LABEL_BUDGET_ID} = $3::uuid,
         ${LABEL_CATEGORY_ID} = $4::uuid,
         ${LABEL_CATEGORY_CONFIDENCE} = $5::float,
         ${UPDATED} = CURRENT_TIMESTAMP
     WHERE ${USER_ID} = $1
       AND ${TRANSACTION_ID} = ANY($2::text[])
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
       AND (
         ${LABEL_CATEGORY_CONFIDENCE} IS NULL
         OR (${LABEL_CATEGORY_CONFIDENCE} > 0 AND ${LABEL_CATEGORY_CONFIDENCE} < 1)
         OR (${LABEL_CATEGORY_CONFIDENCE} >= 1
             AND ${LABEL_BUDGET_ID} IS NOT DISTINCT FROM $6::uuid
             AND ${LABEL_CATEGORY_ID} IS NOT DISTINCT FROM $7::uuid)
         OR (${LABEL_CATEGORY_CONFIDENCE} <= 0
             AND (${LABEL_BUDGET_ID} IS NULL OR ${LABEL_BUDGET_ID} = $6::uuid))
       )
       AND (
         ${LABEL_BUDGET_ID} IS DISTINCT FROM $3::uuid
         OR ${LABEL_CATEGORY_ID} IS DISTINCT FROM $4::uuid
         OR ${LABEL_CATEGORY_CONFIDENCE} IS DISTINCT FROM $5::float
       )`,
    [
      userId,
      transactionIds,
      label.budget_id,
      label.category_id,
      confidence,
      previous.budget_id,
      previous.category_id,
    ],
  );
};

/**
 * The label the user has confirmed most often on these transactions (most
 * recent wins a tie). It's what a recurring starts with when it's confirmed
 * without a default, and what its transactions count as following while it
 * has none.
 */
const seedRecurringLabel = async (
  executor: QueryExecutor,
  userId: string,
  transactionIds: string[],
): Promise<JSONRecurringLabel> => {
  if (transactionIds.length === 0) return EMPTY_LABEL;
  const result = await executor.query<JSONRecurringLabel>(
    `SELECT ${LABEL_BUDGET_ID} AS budget_id, ${LABEL_CATEGORY_ID} AS category_id
     FROM ${TRANSACTIONS}
     WHERE ${USER_ID} = $1
       AND ${TRANSACTION_ID} = ANY($2::text[])
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
       AND ${LABEL_CATEGORY_CONFIDENCE} = 1
       AND ${LABEL_CATEGORY_ID} IS NOT NULL
     GROUP BY ${LABEL_BUDGET_ID}, ${LABEL_CATEGORY_ID}
     ORDER BY COUNT(*) DESC, MAX(date) DESC
     LIMIT 1`,
    [userId, transactionIds],
  );
  const row = result.rows[0];
  return row ? { budget_id: row.budget_id, category_id: row.category_id } : EMPTY_LABEL;
};

/**
 * Split each of `transactionIds` by a recurring's default splits. A charge
 * that already has splits keeps them, and one too small to leave a
 * remainder on the parent is left whole.
 */
const applyRecurringSplits = async (
  executor: QueryExecutor,
  userId: string,
  splits: JSONRecurringSplit[],
  transactionIds: string[],
): Promise<void> => {
  if (splits.length === 0 || transactionIds.length === 0) return;
  const total = Math.round(splits.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
  await executor.query(
    `INSERT INTO ${SPLIT_TRANSACTIONS}
       (${USER_ID}, ${TRANSACTION_ID}, account_id, amount, date,
        ${LABEL_BUDGET_ID}, ${LABEL_CATEGORY_ID}, ${LABEL_CATEGORY_CONFIDENCE})
     SELECT t.${USER_ID}, t.${TRANSACTION_ID}, t.account_id, s.amount * SIGN(t.amount), t.date,
            s.budget_id, s.category_id,
            CASE WHEN s.category_id IS NOT NULL THEN 1 WHEN s.budget_id IS NOT NULL THEN 0 END
     FROM ${TRANSACTIONS} t
     CROSS JOIN UNNEST($3::numeric[], $4::uuid[], $5::uuid[]) AS s(amount, budget_id, category_id)
     WHERE t.${USER_ID} = $1
       AND t.${TRANSACTION_ID} = ANY($2::text[])
       AND (t.${IS_DELETED} IS NULL OR t.${IS_DELETED} = FALSE)
       AND ABS(t.amount) > $6::numeric
       AND NOT EXISTS (
         SELECT 1 FROM ${SPLIT_TRANSACTIONS} x
         WHERE x.${USER_ID} = t.${USER_ID}
           AND x.${TRANSACTION_ID} = t.${TRANSACTION_ID}
           AND (x.${IS_DELETED} IS NULL OR x.${IS_DELETED} = FALSE)
       )`,
    [
      userId,
      transactionIds,
      splits.map((s) => s.amount),
      splits.map((s) => s.label.budget_id),
      splits.map((s) => s.label.category_id),
      total,
    ],
  );
};

/**
 * Bring a confirmed recurring's transactions in line with its default
 * label. Without `transactionIds` (confirming or creating it) every member
 * is labeled, and a recurring with no default starts one from its members.
 * With them (charges joining it) only those are labeled, and only if it has
 * a default: one the user cleared stays cleared. Joining charges are also
 * split by its default splits. Runs inside the caller's DB transaction,
 * under the recurrings advisory lock.
 */
export const labelConfirmedRecurring = async (
  executor: QueryExecutor,
  userId: string,
  recurring_id: string,
  transactionIds?: string[],
): Promise<void> => {
  const found = await executor.query<{
    label_budget_id: string | null;
    label_category_id: string | null;
    transaction_ids: string[];
    splits: JSONRecurringSplit[];
  }>(
    `SELECT ${LABEL_BUDGET_ID}, ${LABEL_CATEGORY_ID}, ${TRANSACTION_IDS}, ${SPLITS} FROM ${RECURRINGS}
     WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2 AND ${STATUS} = 'confirmed'`,
    [userId, recurring_id],
  );
  const row = found.rows[0];
  if (!row) return;
  if (transactionIds) await applyRecurringSplits(executor, userId, row.splits ?? [], transactionIds);
  let label: JSONRecurringLabel = {
    budget_id: row.label_budget_id,
    category_id: row.label_category_id,
  };
  if (isEmptyLabel(label)) {
    if (transactionIds) return;
    label = await seedRecurringLabel(executor, userId, row.transaction_ids);
    if (isEmptyLabel(label)) return;
    await executor.query(
      `UPDATE ${RECURRINGS}
       SET ${LABEL_BUDGET_ID} = $3::uuid, ${LABEL_CATEGORY_ID} = $4::uuid, ${UPDATED} = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2`,
      [userId, recurring_id, label.budget_id, label.category_id],
    );
  }
  await applyRecurringLabel(
    executor,
    userId,
    label,
    transactionIds ?? row.transaction_ids,
    label,
  );
};

/**
 * Confirm a suggested recurring: status flips to "confirmed" and its
 * transactions take its default label (seeded from them if it has none).
 * Confirmed recurrings auto-attach future matching charges on subsequent
 * detection runs.
 */
export const confirmRecurring = async (
  user: MaskedUser,
  recurring_id: string,
): Promise<RecurringConfirmResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRecurrings(client, user.user_id);
    const updated = await client.query(
      `UPDATE ${RECURRINGS}
       SET ${STATUS} = 'confirmed', ${UPDATED} = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
       RETURNING ${RECURRING_ID}`,
      [user.user_id, recurring_id],
    );
    if ((updated.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Recurring not found." };
    }
    await labelConfirmedRecurring(client, user.user_id, recurring_id);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Set a recurring's default label. While it's confirmed its transactions
 * follow the change, except ones the user labeled differently from the old
 * default. A suggested recurring just keeps the label for when it's
 * confirmed. An empty label clears the default: nothing is relabeled, and
 * charges joining later keep their own labels.
 */
export const setRecurringLabel = async (
  user: MaskedUser,
  recurring_id: string,
  label: JSONRecurringLabel,
): Promise<RecurringConfirmResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRecurrings(client, user.user_id);
    const found = await client.query<{
      label_budget_id: string | null;
      label_category_id: string | null;
      status: RecurringStatus;
      transaction_ids: string[];
    }>(
      `SELECT ${LABEL_BUDGET_ID}, ${LABEL_CATEGORY_ID}, ${STATUS}, ${TRANSACTION_IDS} FROM ${RECURRINGS}
       WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
      [user.user_id, recurring_id],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Recurring not found." };
    }
    await client.query(
      `UPDATE ${RECURRINGS}
       SET ${LABEL_BUDGET_ID} = $3::uuid, ${LABEL_CATEGORY_ID} = $4::uuid, ${UPDATED} = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2`,
      [user.user_id, recurring_id, label.budget_id, label.category_id],
    );
    if (row.status === "confirmed") {
      // With no stored default (one confirmed before defaults existed, or
      // one the user cleared), its transactions follow the label they're
      // most often confirmed with, so that's what moves to the new default.
      const stored: JSONRecurringLabel = {
        budget_id: row.label_budget_id,
        category_id: row.label_category_id,
      };
      const previous = isEmptyLabel(stored)
        ? await seedRecurringLabel(client, user.user_id, row.transaction_ids)
        : stored;
      await applyRecurringLabel(client, user.user_id, label, row.transaction_ids, previous);
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Set the splits a recurring's joining charges take. Charges already in it
 * are left as they are; an empty list stops splitting new ones.
 */
export const setRecurringSplits = async (
  user: MaskedUser,
  recurring_id: string,
  splits: JSONRecurringSplit[],
): Promise<RecurringConfirmResult> => {
  const result = await recurringsTable.update(
    recurring_id,
    { [SPLITS]: JSON.stringify(splits) },
    undefined,
    user.user_id,
    undefined,
    undefined,
    true,
  );
  if (!result) {
    return { ok: false, error: "Recurring not found." };
  }
  return { ok: true };
};

/**
 * Dismiss a suggested (or confirmed) recurring: flips to
 * `status='dismissed'` (not soft-delete). The row persists as the
 * detection engine's per-merchant denylist signal so the same merchant
 * group isn't re-suggested on future runs — mirrors transfers'
 * `rejectTransferPair`. Re-adding goes through `createRecurring`, which
 * un-dismisses.
 */
export const dismissRecurring = async (
  user: MaskedUser,
  recurring_id: string,
): Promise<RecurringConfirmResult> => {
  const result = await recurringsTable.update(
    recurring_id,
    { [STATUS]: "dismissed" as RecurringStatus },
    undefined,
    user.user_id,
  );
  if (!result) {
    return { ok: false, error: "Recurring not found." };
  }
  return { ok: true };
};

/**
 * Rename a recurring. The name is display-only (grouping runs on
 * `merchant_key`), and detection never rewrites an existing row's name, so
 * the user's choice sticks.
 */
export const renameRecurring = async (
  user: MaskedUser,
  recurring_id: string,
  merchant_name: string,
): Promise<RecurringConfirmResult> => {
  const result = await recurringsTable.update(
    recurring_id,
    { [MERCHANT_NAME]: merchant_name },
    undefined,
    user.user_id,
  );
  if (!result) {
    return { ok: false, error: "Recurring not found." };
  }
  return { ok: true };
};

export interface CreateRecurringInput {
  transaction_ids: string[];
  merchant_key: string;
  merchant_name: string;
  /** The caller named the recurring explicitly, so the name also replaces
   *  an existing row's when the create lands on one. */
  name_is_custom?: boolean;
  cadence: RecurringCadence;
  is_income: boolean;
}

/**
 * Manually create a recurring from explicit transaction ids (the "mark as
 * recurring" affordance), or un-dismiss a previously-dismissed merchant
 * group. A single transaction is allowed — the user is asserting the
 * pattern, and the detection job's auto-attach will pick up future
 * matches. Wrapped in a single DB transaction with a per-user advisory lock
 * so concurrent creates can't put one transaction in two active recurrings.
 *
 * Invariants enforced:
 *   - REJECT if any transaction is already in ANOTHER active recurring.
 *     A transaction may appear in at most one active recurring.
 *   - ALLOW re-creating a previously-dismissed merchant group — the
 *     ON CONFLICT branch un-dismisses (mirrors pairTransactions'
 *     un-reject). Landing on a still-suggested row confirms it too:
 *     either way the user has just said this merchant recurs.
 */
export const createRecurring = async (
  user: MaskedUser,
  input: CreateRecurringInput,
): Promise<RecurringResult> => {
  const uniqueIds = [...new Set(input.transaction_ids)];
  if (uniqueIds.length < 1) {
    return {
      ok: false,
      error: "A recurring needs at least one transaction.",
    };
  }

  const recurring_id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))`,
      [user.user_id],
    );

    // Existence pre-check: every transaction must exist, be alive, and
    // belong to this user. `FOR SHARE` serializes against a concurrent
    // delete (mirrors pairTransactions).
    const existence = await client.query<{ transaction_id: string }>(
      `SELECT ${TRANSACTION_ID} FROM ${TRANSACTIONS}
       WHERE ${USER_ID} = $1
         AND ${TRANSACTION_ID} = ANY($2::text[])
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
       FOR SHARE`,
      [user.user_id, uniqueIds],
    );
    if ((existence.rowCount ?? 0) !== uniqueIds.length) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One or more transactions no longer exist (deleted or never belonged to this user).",
      };
    }

    // Collision pre-check: is ANY transaction already in another active
    // recurring? The transaction_ids array makes this a single overlap
    // probe with the && array operator. Rows for the same
    // (merchant_key, is_income) that are merely dismissed don't collide —
    // the upsert below un-dismisses them.
    const collision = await client.query<{ recurring_id: string }>(
      `SELECT ${RECURRING_ID} FROM ${RECURRINGS}
       WHERE ${USER_ID} = $1
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} <> 'dismissed'
         AND ${TRANSACTION_IDS} && $2::text[]
       LIMIT 1`,
      [user.user_id, uniqueIds],
    );
    if (collision.rowCount && collision.rowCount > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One of these transactions is already in another recurring. Remove it from the existing recurring first.",
      };
    }

    const result = await client.query<{ recurring_id: string }>(
      `INSERT INTO ${RECURRINGS}
         (${RECURRING_ID}, ${USER_ID}, ${MERCHANT_KEY}, ${MERCHANT_NAME}, ${CADENCE}, ${IS_INCOME}, ${STATUS}, ${TRANSACTION_IDS})
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7)
       ON CONFLICT (${USER_ID}, ${MERCHANT_KEY}, ${IS_INCOME}) DO UPDATE SET
         ${STATUS} = 'confirmed',
         ${MERCHANT_NAME} = CASE
           WHEN $8::boolean THEN EXCLUDED.${MERCHANT_NAME}
           ELSE ${RECURRINGS}.${MERCHANT_NAME}
         END,
         ${TRANSACTION_IDS} = (
           SELECT ARRAY(SELECT DISTINCT UNNEST(${RECURRINGS}.${TRANSACTION_IDS} || EXCLUDED.${TRANSACTION_IDS}))
         ),
         ${IS_DELETED} = FALSE,
         ${UPDATED} = CURRENT_TIMESTAMP
       RETURNING ${RECURRING_ID}`,
      [
        recurring_id,
        user.user_id,
        input.merchant_key,
        input.merchant_name,
        input.cadence,
        input.is_income,
        uniqueIds,
        !!input.name_is_custom,
      ],
    );
    const created_id = result.rows[0].recurring_id;
    await labelConfirmedRecurring(client, user.user_id, created_id);

    await client.query("COMMIT");
    return { ok: true, recurring_id: created_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Add transactions to an existing recurring (the "add to recurring"
 * affordance on the transaction detail page). The recurring keeps its
 * merchant_key/cadence/is_income; the added transactions just join its
 * member set.
 *
 * Invariants enforced (same guards as createRecurring):
 *   - The recurring must exist, belong to this user, be alive, and not
 *     be dismissed (adding to a dismissed group would fight the denylist).
 *   - Every transaction must exist, be alive, and belong to this user.
 *   - REJECT if any transaction is already in ANOTHER active recurring.
 *     Transactions already in THIS recurring are silently deduped.
 *   - REJECT if a transaction's direction doesn't match the recurring's
 *     is_income — an income recurring can't hold a charge.
 */
export const addToRecurring = async (
  user: MaskedUser,
  recurring_id: string,
  transaction_ids: string[],
): Promise<RecurringResult> => {
  const uniqueIds = [...new Set(transaction_ids)];
  if (uniqueIds.length === 0) {
    return { ok: false, error: "No transactions to add." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))`,
      [user.user_id],
    );

    const rec = await client.query(
      `SELECT ${RECURRING_ID}, ${IS_INCOME}, ${STATUS} FROM ${RECURRINGS}
       WHERE ${USER_ID} = $1 AND ${RECURRING_ID} = $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
      [user.user_id, recurring_id],
    );
    if ((rec.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: "That recurring no longer exists.",
      };
    }
    const row = rec.rows[0];
    if (row[STATUS] === "dismissed") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: "That recurring was dismissed. Confirm it again before adding transactions.",
      };
    }
    const is_income = row[IS_INCOME] as boolean;

    const txns = await client.query<{ transaction_id: string; amount: string }>(
      `SELECT ${TRANSACTION_ID}, amount FROM ${TRANSACTIONS}
       WHERE ${USER_ID} = $1
         AND ${TRANSACTION_ID} = ANY($2::text[])
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND pending = FALSE
       FOR SHARE`,
      [user.user_id, uniqueIds],
    );
    if ((txns.rowCount ?? 0) !== uniqueIds.length) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One or more transactions no longer exist (deleted or never belonged to this user).",
      };
    }
    const wrongDirection = txns.rows.some(
      (t) => (Number(t.amount) < 0) !== is_income,
    );
    if (wrongDirection) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: is_income
          ? "That recurring holds income — only deposits can join it."
          : "That recurring holds charges — only expenses can join it.",
      };
    }

    const collision = await client.query<{ recurring_id: string }>(
      `SELECT ${RECURRING_ID} FROM ${RECURRINGS}
       WHERE ${USER_ID} = $1
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} <> 'dismissed'
         AND ${RECURRING_ID} <> $2
         AND ${TRANSACTION_IDS} && $3::text[]
       LIMIT 1`,
      [user.user_id, recurring_id, uniqueIds],
    );
    if (collision.rowCount && collision.rowCount > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One of these transactions is already in another recurring. Remove it from the existing recurring first.",
      };
    }

    await client.query(
      `UPDATE ${RECURRINGS}
       SET ${TRANSACTION_IDS} = (
         SELECT ARRAY(SELECT DISTINCT UNNEST(${TRANSACTION_IDS} || $2::text[]))
       ),
       ${UPDATED} = CURRENT_TIMESTAMP
       WHERE ${RECURRING_ID} = $1 AND ${USER_ID} = $3`,
      [recurring_id, uniqueIds, user.user_id],
    );
    await labelConfirmedRecurring(client, user.user_id, recurring_id, uniqueIds);

    await client.query("COMMIT");
    return { ok: true, recurring_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
