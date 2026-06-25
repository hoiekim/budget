import { JSONTransaction, TransferPairStatus } from "common";
import { pool } from "../client";
import {
  MaskedUser,
  transactionsTable,
  transactionPairsTable,
  TRANSACTION_PAIRS,
  USER_ID,
  PAIR_ID,
  TRANSACTION_ID_A,
  TRANSACTION_ID_B,
  TRANSACTION_ID,
  STATUS,
  IS_DELETED,
  canonicalizePairIds,
} from "../models";

export interface TransferPair {
  pair_id: string;
  status: TransferPairStatus;
  transactions: JSONTransaction[];
}

/**
 * Result of a pair/confirm mutation. The route translates `ok: false` into a
 * `{ status: "failed", message }` response so the FE can surface the conflict.
 */
export type PairResult =
  | { ok: true; pair_id: string }
  | { ok: false; error: string };

export type ConfirmResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Get all transfer pairs for a user. JOINs the pairs table to the two
 * transactions referenced by each pair so the response shape stays the same
 * as before (one entry per pair, with the two paired transactions inline).
 */
export const getTransferPairs = async (user: MaskedUser): Promise<TransferPair[]> => {
  // Table.query auto-excludes soft-deleted rows (supportsSoftDelete).
  const allPairs = await transactionPairsTable.query(
    { [USER_ID]: user.user_id },
    { orderBy: PAIR_ID },
  );

  // Exclude status='rejected' from the FE response: a rejected pair is
  // user-marked "no, these don't pair" — the engine remembers it as a
  // denylist signal but the user shouldn't see the pair in their Transfers
  // view. Re-confirming a previously-rejected pair goes through
  // `pairTransactions` (Mark as Transfer), which un-rejects via ON CONFLICT.
  // Filtered in JS because Table.query expresses only equality / IN filters,
  // not the `STATUS <> 'rejected'` inequality.
  const pairs = allPairs.filter((p) => p.status !== "rejected");

  if (pairs.length === 0) return [];

  const txnIds = pairs.flatMap((p) => [p.transaction_id_a, p.transaction_id_b]);

  const txnModels = await transactionsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [TRANSACTION_ID]: txnIds } },
  );

  const txnById = new Map<string, JSONTransaction>();
  for (const m of txnModels) {
    const tx = m.toJSON();
    txnById.set(tx.transaction_id, tx);
  }

  return pairs
    .map((pair): TransferPair | null => {
      const a = txnById.get(pair.transaction_id_a);
      const b = txnById.get(pair.transaction_id_b);
      if (!a || !b) return null;
      return {
        pair_id: pair.pair_id,
        status: pair.status,
        transactions: [a, b],
      };
    })
    .filter((p): p is TransferPair => p !== null);
};

/**
 * Pair two transactions as a transfer. Wrapped in a single DB transaction so
 * the collision pre-check, upsert, and cleanup of other suggestions are
 * atomic.
 *
 * Invariants enforced:
 *   - REJECT if either transaction is already in ANOTHER active confirmed
 *     pair (i.e. not the same `(a, b)` we're re-pairing). A transaction may
 *     appear in at most one active confirmed pair.
 *   - ALLOW re-pairing a previously-rejected `(a, b)` — the ON CONFLICT
 *     branch un-rejects.
 *   - On successful upsert, REJECT (status='rejected') any OTHER active
 *     SUGGESTED pair that involves either `a` or `b`. The user's
 *     explicit pairing is an implicit "the other engine guesses for
 *     these transactions are wrong" — flipping them to 'rejected'
 *     persists that intent through the engine's per-pair denylist on
 *     future runs. Consistent with transaction labeling: confirming
 *     one category implicitly rejects the engine's other category
 *     guesses, and the engine remembers.
 */
export const pairTransactions = async (
  user: MaskedUser,
  transaction_id_a: string,
  transaction_id_b: string,
  status: TransferPairStatus = "suggested",
): Promise<PairResult> => {
  const pair_id = crypto.randomUUID();
  const canonical = canonicalizePairIds(transaction_id_a, transaction_id_b);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Per-user serialization for all transfer-pair mutations. Without
    // this, two concurrent `pairTransactions(A, B)` and `confirmTransferPair`
    // calls (e.g. double-click, two browser tabs) can each pass the
    // collision SELECT before either commits — READ COMMITTED isolation
    // hides the in-flight UPDATE — and both succeed, leaving A in two
    // simultaneous active confirmed pairs (the exact invariant we're
    // here to enforce). `pg_advisory_xact_lock` is a transaction-scoped
    // per-key lock; the second concurrent call waits for the first to
    // COMMIT/ROLLBACK, then sees the new state and the collision check
    // fires correctly. Per-user-id scope: throughput is fine for
    // many-user deployments since users only contend with themselves.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':transfers'))`, [
      user.user_id,
    ]);

    // Collision pre-check: is EITHER transaction in another active confirmed
    // pair with a different counterparty? If so, refuse — confirming would
    // put the transaction in two simultaneous confirmed pairs.
    const collision = await client.query<{ pair_id: string }>(
      `SELECT ${PAIR_ID} FROM ${TRANSACTION_PAIRS}
       WHERE ${USER_ID} = $1
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} = 'confirmed'
         AND (${TRANSACTION_ID_A} = $2 OR ${TRANSACTION_ID_B} = $2
              OR ${TRANSACTION_ID_A} = $3 OR ${TRANSACTION_ID_B} = $3)
         AND NOT (${TRANSACTION_ID_A} = $4 AND ${TRANSACTION_ID_B} = $5)
       LIMIT 1`,
      [
        user.user_id,
        canonical.transaction_id_a,
        canonical.transaction_id_b,
        canonical.transaction_id_a,
        canonical.transaction_id_b,
      ],
    );
    if (collision.rowCount && collision.rowCount > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first.",
      };
    }

    const result = await client.query<{ pair_id: string }>(
      `INSERT INTO ${TRANSACTION_PAIRS}
         (${PAIR_ID}, ${USER_ID}, ${TRANSACTION_ID_A}, ${TRANSACTION_ID_B}, ${STATUS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (${TRANSACTION_ID_A}, ${TRANSACTION_ID_B}) DO UPDATE SET
         ${STATUS} = CASE
           WHEN ${TRANSACTION_PAIRS}.${IS_DELETED} = TRUE THEN EXCLUDED.${STATUS}
           WHEN ${TRANSACTION_PAIRS}.${STATUS} = 'rejected' THEN EXCLUDED.${STATUS}
           ELSE ${TRANSACTION_PAIRS}.${STATUS}
         END,
         ${IS_DELETED} = FALSE,
         updated = CASE
           WHEN ${TRANSACTION_PAIRS}.${IS_DELETED} = TRUE
             OR ${TRANSACTION_PAIRS}.${STATUS} = 'rejected'
             THEN CURRENT_TIMESTAMP
           ELSE ${TRANSACTION_PAIRS}.updated
         END
       RETURNING ${PAIR_ID}`,
      [pair_id, user.user_id, canonical.transaction_id_a, canonical.transaction_id_b, status],
    );

    const effectivePairId = result.rows[0].pair_id;

    // Cleanup: REJECT any OTHER active SUGGESTED pair involving either of
    // these transactions. The user's manual pair (or re-pair) is an
    // explicit "this is the right pairing" — any other engine suggestion
    // for the same transactions is implicitly the wrong pairing. We mark
    // those `status='rejected'` so the engine's per-pair denylist
    // (`fetchCandidates`'s second NOT EXISTS) won't re-suggest them on
    // a future run, even if the new confirmed pair is later unpaired.
    //
    // Consistent with transaction labeling: when the user labels a
    // transaction as a specific category, that's an implicit rejection
    // of the engine's other category guesses — and the suggestion engine
    // remembers it. Same model here.
    //
    // Use `status='rejected'` not `is_deleted=TRUE`. Soft-delete is the
    // SYSTEM-side cascade for when a referenced transaction itself is
    // removed (Plaid tombstone, manual delete); the per-pair denylist
    // does NOT apply to soft-deleted rows, so the engine could re-emit
    // the same pair later. Rejection is the persistent USER-intent
    // denylist that survives.
    await client.query(
      `UPDATE ${TRANSACTION_PAIRS}
       SET ${STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} = 'suggested'
         AND ${PAIR_ID} <> $2
         AND (${TRANSACTION_ID_A} = $3 OR ${TRANSACTION_ID_B} = $3
              OR ${TRANSACTION_ID_A} = $4 OR ${TRANSACTION_ID_B} = $4)`,
      [
        user.user_id,
        effectivePairId,
        canonical.transaction_id_a,
        canonical.transaction_id_b,
      ],
    );

    await client.query("COMMIT");
    return { ok: true, pair_id: effectivePairId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Confirm a suggested transfer pair. Wrapped in a single DB transaction so
 * the lookup, collision pre-check, status update, and cleanup are atomic.
 *
 * Invariants enforced:
 *   - REJECT if either of the pair's transactions is already in ANOTHER
 *     active confirmed pair. The data-integrity contract is "at most one
 *     active confirmed pair per transaction" — confirming the stale
 *     `(A, B)` suggestion while `(A, C)` is already confirmed would
 *     violate that.
 *   - On successful confirm, REJECT (status='rejected') any OTHER active
 *     SUGGESTED pair involving the pair's transactions (engine-generated
 *     alternatives for either half are now wrong, and the engine's
 *     per-pair denylist remembers).
 */
export const confirmTransferPair = async (
  user: MaskedUser,
  pair_id: string,
): Promise<ConfirmResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Per-user advisory lock — see comment in `pairTransactions`. Same
    // race-window concern: a concurrent confirm of a different pair_id
    // involving the same transaction would slip past the collision SELECT.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':transfers'))`, [
      user.user_id,
    ]);

    // Look up the pair's transaction_ids. If missing, soft-deleted, or a
    // rejection record (kept as engine denylist, not user-promotable),
    // fail cleanly. Status filter blocks a client from directly POSTing
    // a rejected pair's pair_id to confirm it (FE filters rejected from
    // `getTransferPairs`, but the server shouldn't rely on that).
    const lookup = await client.query<{ transaction_id_a: string; transaction_id_b: string }>(
      `SELECT ${TRANSACTION_ID_A}, ${TRANSACTION_ID_B} FROM ${TRANSACTION_PAIRS}
       WHERE ${PAIR_ID} = $1 AND ${USER_ID} = $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} <> 'rejected'`,
      [pair_id, user.user_id],
    );
    if (!lookup.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Pair not found." };
    }
    const { transaction_id_a, transaction_id_b } = lookup.rows[0];

    // Collision pre-check: is EITHER transaction already in ANOTHER active
    // confirmed pair?
    const collision = await client.query<{ pair_id: string }>(
      `SELECT ${PAIR_ID} FROM ${TRANSACTION_PAIRS}
       WHERE ${USER_ID} = $1
         AND ${PAIR_ID} <> $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} = 'confirmed'
         AND (${TRANSACTION_ID_A} = $3 OR ${TRANSACTION_ID_B} = $3
              OR ${TRANSACTION_ID_A} = $4 OR ${TRANSACTION_ID_B} = $4)
       LIMIT 1`,
      [user.user_id, pair_id, transaction_id_a, transaction_id_b],
    );
    if (collision.rowCount && collision.rowCount > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first.",
      };
    }

    await client.query(
      `UPDATE ${TRANSACTION_PAIRS}
       SET ${STATUS} = 'confirmed', updated = CURRENT_TIMESTAMP
       WHERE ${PAIR_ID} = $1
         AND ${USER_ID} = $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
      [pair_id, user.user_id],
    );

    // Cleanup: REJECT any OTHER active SUGGESTED pair involving the
    // pair's transactions. Same intent + mechanism as `pairTransactions`
    // above — confirming this pair implicitly rejects any other engine
    // suggestion for these transactions, and the engine's per-pair
    // denylist remembers the rejection persistently. Existing rejected
    // rows stay rejected (the filter scopes to `status='suggested'`).
    await client.query(
      `UPDATE ${TRANSACTION_PAIRS}
       SET ${STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
       WHERE ${USER_ID} = $1
         AND ${PAIR_ID} <> $2
         AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)
         AND ${STATUS} = 'suggested'
         AND (${TRANSACTION_ID_A} = $3 OR ${TRANSACTION_ID_B} = $3
              OR ${TRANSACTION_ID_A} = $4 OR ${TRANSACTION_ID_B} = $4)`,
      [user.user_id, pair_id, transaction_id_a, transaction_id_b],
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Reject a transfer pairing — marks the pair `status = 'rejected'` so the
 * suggestion engine remembers the user's "no" and won't re-suggest THIS
 * specific pair on future runs. The pair row stays present (is_deleted
 * = FALSE) so the rejection is queryable; the two transactions remain
 * eligible to be paired with OTHER counterparts.
 *
 * Distinct from soft-deletion (`is_deleted = TRUE`): soft-deletion is
 * the system-side cascade when one of the paired transactions itself
 * gets removed (Plaid tombstone, manual delete) — it has no user-intent
 * semantics and the surviving transaction is fully eligible for new
 * suggestions, including the same counterpart if it returns.
 *
 * Naming: function was previously `removeTransferPair` (soft-delete);
 * renamed to reflect the actual semantics now that rejection and
 * deletion are distinct.
 */
export const rejectTransferPair = async (
  user: MaskedUser,
  pair_id: string,
): Promise<void> => {
  await pool.query(
    `UPDATE ${TRANSACTION_PAIRS}
     SET ${STATUS} = 'rejected', updated = CURRENT_TIMESTAMP
     WHERE ${PAIR_ID} = $1
       AND ${USER_ID} = $2
       AND (${IS_DELETED} IS NULL OR ${IS_DELETED} = FALSE)`,
    [pair_id, user.user_id],
  );
};
