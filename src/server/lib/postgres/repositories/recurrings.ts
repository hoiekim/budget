import {
  JSONTransaction,
  RecurringStatus,
  RecurringCadence,
} from "common";
import { pool } from "../client";
import {
  MaskedUser,
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
  IS_DELETED,
  UPDATED,
} from "../models";
import { TRANSACTIONS, RECURRINGS } from "common/constants";

export interface Recurring {
  recurring_id: string;
  merchant_key: string;
  merchant_name: string;
  cadence: RecurringCadence;
  is_income: boolean;
  status: RecurringStatus;
  transactions: JSONTransaction[];
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
      updated: r.updated,
    });
  }

  return [...active, ...evictions];
};

/**
 * Confirm a suggested recurring: status flips to "confirmed". Confirmed
 * recurrings auto-attach future matching charges on subsequent detection
 * runs.
 */
export const confirmRecurring = async (
  user: MaskedUser,
  recurring_id: string,
): Promise<RecurringConfirmResult> => {
  const result = await recurringsTable.update(
    recurring_id,
    { [STATUS]: "confirmed" as RecurringStatus },
    undefined,
    user.user_id,
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

export interface CreateRecurringInput {
  transaction_ids: string[];
  merchant_key: string;
  merchant_name: string;
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
 *     un-reject).
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
         ${STATUS} = CASE
           WHEN ${RECURRINGS}.${STATUS} = 'dismissed' THEN 'confirmed'
           ELSE ${RECURRINGS}.${STATUS}
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
      ],
    );

    await client.query("COMMIT");
    return { ok: true, recurring_id: result.rows[0].recurring_id };
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

    await client.query("COMMIT");
    return { ok: true, recurring_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
