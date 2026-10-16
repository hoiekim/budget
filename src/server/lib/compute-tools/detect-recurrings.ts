import { RecurringCadence } from "common";
import { pool, logger, usersTable, labelConfirmedRecurring } from "server";
import type { PoolClient } from "pg";
import {
  recurringsTable,
  QueryExecutor,
  USER_ID,
  RECURRING_ID,
  MERCHANT_KEY,
  MERCHANT_NAME,
  CADENCE,
  IS_INCOME,
  STATUS,
  TRANSACTION_IDS,
  IS_DELETED,
  UPDATED,
} from "../postgres/models";
import { RECURRINGS } from "common/constants";

/** Minimum settled occurrences before a merchant group is considered. */
const MIN_OCCURRENCES = 3;
/**
 * Every charge must land within ±25% of the group's median amount.
 * Bills like utilities legitimately vary; tighter than this drops real
 * recurrings, looser admits coincidental same-merchant spending.
 */
const AMOUNT_TOLERANCE_RATIO = 0.25;
/**
 * A group whose most recent occurrence is older than 2× its cadence is
 * treated as lapsed (cancelled subscription, switched provider, …) and
 * excluded — the surface is "what recurs now", not history.
 */
const LAPSED_CADENCE_MULTIPLE = 2;

const CADENCE_SPECS: {
  cadence: RecurringCadence;
  days: number;
  toleranceDays: number;
}[] = [
  { cadence: "weekly", days: 7, toleranceDays: 2 },
  { cadence: "biweekly", days: 14, toleranceDays: 3 },
  { cadence: "monthly", days: 30.44, toleranceDays: 5 },
  { cadence: "quarterly", days: 91.31, toleranceDays: 10 },
  { cadence: "semiannual", days: 182.62, toleranceDays: 15 },
  { cadence: "annual", days: 365.25, toleranceDays: 30 },
];

/**
 * Domain-suffix tokens that Plaid appends to web-billed merchants
 * ("NETFLIX.COM" vs "Netflix"). Stripped only in trailing position so a
 * merchant genuinely named e.g. "Comcast" (leading token) is untouched.
 */
const DOMAIN_SUFFIX_TOKENS = new Set(["com", "net", "org"]);

/**
 * Normalize a merchant display string into a grouping key. Plaid merchant
 * names carry per-charge noise — domain suffixes ("NETFLIX.COM"),
 * phone-number suffixes ("Netflix 8665795717"), punctuation, case drift —
 * so the key lowercases, drops punctuation, drops long digit runs
 * (reference/phone numbers) while keeping short ones ("7-Eleven" keeps
 * its 7), and drops trailing domain-suffix tokens.
 */
export const normalizeMerchantName = (raw: string): string => {
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = cleaned
    .split(/\s+/)
    .filter((token) => token && !/^\d{5,}$/.test(token));
  while (
    tokens.length > 1 &&
    DOMAIN_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)
  ) {
    tokens.pop();
  }
  return tokens.join(" ");
};

export interface RecurringCandidate {
  transaction_id: string;
  /** Plaid sign convention: positive = money out, negative = money in. */
  amount: number;
  /** YYYY-MM-DD (the transaction's effective date). */
  date: string;
  merchant_name: string | null;
  name: string;
}

export interface DetectedRecurringGroup {
  merchant_key: string;
  merchant_name: string;
  cadence: RecurringCadence;
  is_income: boolean;
  /** transaction_ids, oldest first. */
  transaction_ids: string[];
}

const medianOfSorted = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const daysBetween = (a: string, b: string): number =>
  Math.round(
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) /
      86_400_000,
  );

const mostCommon = (values: string[]): string => {
  const counts = new Map<string, number>();
  let best = values[0]!;
  let bestCount = 0;
  for (const v of values) {
    const count = (counts.get(v) || 0) + 1;
    counts.set(v, count);
    if (count > bestCount) {
      bestCount = count;
      best = v;
    }
  }
  return best;
};

/**
 * Group candidate transactions into recurring groups. Pure: the caller owns
 * candidate selection (pending/zero-amount/hidden-account/confirmed-transfer
 * filtering); this function only groups and qualifies.
 *
 * A merchant group becomes a recurring when it has ≥3 occurrences whose
 * consecutive intervals all land within tolerance of one cadence, whose
 * amounts all land within ±25% of the median, and whose most recent
 * occurrence is within 2× the cadence of `now` (lapsed groups excluded).
 * Income and expense occurrences of the same merchant form separate groups.
 *
 * `now` is injectable so tests can pin the recency check.
 */
export const detectRecurringGroups = (
  candidates: RecurringCandidate[],
  now: Date = new Date(),
): DetectedRecurringGroup[] => {
  const todayStr = now.toISOString().slice(0, 10);
  const groups = new Map<string, RecurringCandidate[]>();
  for (const t of candidates) {
    if (!t.amount) continue;
    const key = normalizeMerchantName(t.merchant_name || t.name || "");
    if (!key) continue;
    if (Number.isNaN(new Date(t.date + "T00:00:00").getTime())) continue;
    // Direction split: the same merchant can bill and pay (marketplace
    // payouts vs. purchases) — those are different recurrings.
    const groupKey = `${key}::${t.amount < 0 ? "in" : "out"}`;
    const list = groups.get(groupKey);
    if (list) list.push(t);
    else groups.set(groupKey, [t]);
  }

  const result: DetectedRecurringGroup[] = [];
  for (const occurrences of groups.values()) {
    if (occurrences.length < MIN_OCCURRENCES) continue;
    occurrences.sort((a, b) => (a.date < b.date ? -1 : 1));

    const intervals: number[] = [];
    for (let i = 1; i < occurrences.length; i++) {
      intervals.push(daysBetween(occurrences[i - 1]!.date, occurrences[i]!.date));
    }
    const medianInterval = medianOfSorted([...intervals].sort((a, b) => a - b));
    const spec = CADENCE_SPECS.find(
      (s) => Math.abs(medianInterval - s.days) <= s.toleranceDays,
    );
    if (!spec) continue;
    if (!intervals.every((d) => Math.abs(d - spec.days) <= spec.toleranceDays))
      continue;

    const absAmounts = occurrences.map((o) => Math.abs(o.amount));
    const medianAmount = medianOfSorted([...absAmounts].sort((a, b) => a - b));
    const amountOk = absAmounts.every(
      (a) => Math.abs(a - medianAmount) <= medianAmount * AMOUNT_TOLERANCE_RATIO,
    );
    if (!amountOk) continue;

    const first = occurrences[0]!;
    const last = occurrences[occurrences.length - 1]!;
    if (daysBetween(last.date, todayStr) > spec.days * LAPSED_CADENCE_MULTIPLE)
      continue;

    const merchant_key = normalizeMerchantName(
      first.merchant_name || first.name || "",
    );
    result.push({
      merchant_key,
      merchant_name: mostCommon(
        occurrences.map((o) => o.merchant_name || o.name),
      ),
      cadence: spec.cadence,
      is_income: first.amount < 0,
      transaction_ids: occurrences.map((o) => o.transaction_id),
    });
  }

  return result;
};

const fetchCandidates = async (
  userId: string,
  executor: QueryExecutor,
): Promise<RecurringCandidate[]> => {
  // Mirrors the transfer engine's candidate hygiene: hidden accounts are
  // duplicate-data views (their transactions mirror a visible account),
  // and confirmed transfer halves are inter-account money movement, not
  // bills or income — a monthly savings transfer would otherwise read as
  // a recurring "bill".
  const result = await executor.query(
    `SELECT
       t.transaction_id,
       t.amount,
       t.date::text AS date,
       t.merchant_name,
       t.name
     FROM transactions t
     JOIN accounts a ON a.account_id = t.account_id
     WHERE t.user_id = $1
       AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
       AND COALESCE(t.pending, FALSE) = FALSE
       AND t.amount <> 0
       AND COALESCE(a.hide, FALSE) = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM transaction_pairs tp
         WHERE tp.user_id = t.user_id
           AND (tp.is_deleted IS NULL OR tp.is_deleted = FALSE)
           AND tp.status = 'confirmed'
           AND (tp.transaction_id_a = t.transaction_id
                OR tp.transaction_id_b = t.transaction_id)
       )
     ORDER BY t.transaction_id`,
    [userId],
  );
  return result.rows.map((row) => ({
    transaction_id: row.transaction_id as string,
    amount: Number(row.amount),
    date: (row.date as string).slice(0, 10),
    merchant_name: row.merchant_name as string | null,
    name: row.name as string,
  }));
};

const sameIdSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
};

/**
 * Background job that scans settled transactions and suggests recurrings.
 *
 * Per user (under an advisory lock serializing against manual
 * `createRecurring` calls and concurrent detection runs):
 *   1. Cascade-soft-delete recurrings whose members are all soft-deleted
 *      (mirrors the transfer engine's stale-pair cleanup).
 *   2. Group candidates with `detectRecurringGroups`.
 *   3. For each group, reconcile against the existing row for
 *      (merchant_key, is_income):
 *        - none → INSERT with status='suggested'
 *        - dismissed → skip (the denylist: the user said "no" to this
 *          merchant group, not "these transactions can never recur")
 *        - suggested → refresh transaction_ids when the set changed
 *        - confirmed → append newly-detected transaction_ids (this is how
 *          a confirmed recurring picks up each new charge over time)
 */
export const runRecurringDetection = async (): Promise<void> => {
  logger.info("Recurring-detection job started");

  let totalUsers = 0;
  let totalSuggested = 0;

  try {
    const users = await usersTable.query({});
    for (const user of users) {
      const userId = user.user_id;
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1 || ':recurrings'))`,
          [userId],
        );
        const executor: QueryExecutor = client;

        // Stale cleanup: a recurring whose members are ALL soft-deleted is
        // a ghost — soft-delete it so it stops rendering and stops
        // claiming nothing.
        const staleCleanup = await client.query(
          `UPDATE ${RECURRINGS} r
           SET ${IS_DELETED} = TRUE, ${UPDATED} = CURRENT_TIMESTAMP
           WHERE r.${USER_ID} = $1
             AND (r.${IS_DELETED} IS NULL OR r.${IS_DELETED} = FALSE)
             AND NOT EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.${USER_ID} = $1
                 AND t.transaction_id = ANY(r.${TRANSACTION_IDS})
                 AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
             )`,
          [userId],
        );
        if ((staleCleanup.rowCount ?? 0) > 0) {
          logger.info("Cleaned stale recurrings", {
            userId,
            count: staleCleanup.rowCount,
          });
        }

        const candidates = await fetchCandidates(userId, executor);
        const groups = detectRecurringGroups(candidates);

        const existing = await recurringsTable.query(
          { [USER_ID]: userId },
          { excludeDeleted: true },
        );
        const existingByKey = new Map(
          existing.map((r) => [`${r.merchant_key}::${r.is_income}`, r]),
        );

        let userSuggested = 0;
        for (const group of groups) {
          const key = `${group.merchant_key}::${group.is_income}`;
          const row = existingByKey.get(key);

          if (!row) {
            await client.query(
              `INSERT INTO ${RECURRINGS}
                 (${RECURRING_ID}, ${USER_ID}, ${MERCHANT_KEY}, ${MERCHANT_NAME}, ${CADENCE}, ${IS_INCOME}, ${STATUS}, ${TRANSACTION_IDS})
               VALUES ($1, $2, $3, $4, $5, $6, 'suggested', $7)`,
              [
                crypto.randomUUID(),
                userId,
                group.merchant_key,
                group.merchant_name,
                group.cadence,
                group.is_income,
                group.transaction_ids,
              ],
            );
            userSuggested++;
            continue;
          }

          if (row.status === "dismissed") continue;

          if (row.status === "suggested") {
            // Refresh membership when the detected set changed (new
            // charges arrived, or deleted ones fell out of candidacy).
            // No UPDATE when identical — avoids `updated` churn that
            // would spam delta syncs with no-op bumps. The name is left
            // alone: the user may have renamed the suggestion.
            if (!sameIdSet(row.transaction_ids, group.transaction_ids)) {
              await client.query(
                `UPDATE ${RECURRINGS}
                 SET ${TRANSACTION_IDS} = $2, ${CADENCE} = $3, ${UPDATED} = CURRENT_TIMESTAMP
                 WHERE ${RECURRING_ID} = $1`,
                [row.recurring_id, group.transaction_ids, group.cadence],
              );
            }
            continue;
          }

          // Confirmed: append newly-detected members. This is the
          // recurring lifecycle — each new charge joins its bill.
          const known = new Set(row.transaction_ids);
          const fresh = group.transaction_ids.filter((id) => !known.has(id));
          if (fresh.length > 0) {
            await client.query(
              `UPDATE ${RECURRINGS}
               SET ${TRANSACTION_IDS} = ${TRANSACTION_IDS} || $2::text[],
                   ${UPDATED} = CURRENT_TIMESTAMP
               WHERE ${RECURRING_ID} = $1`,
              [row.recurring_id, fresh],
            );
            // New charges take the recurring's default label.
            await labelConfirmedRecurring(client, userId, row.recurring_id, fresh);
          }
        }

        await client.query("COMMIT");
        totalUsers++;
        totalSuggested += userSuggested;
        if (userSuggested > 0) {
          logger.info("Suggested recurrings for user", {
            userId,
            suggested: userSuggested,
            groupsDetected: groups.length,
          });
        }
      } catch (err) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        logger.error("Recurring detection failed for user", { userId }, err);
      } finally {
        if (client) client.release();
      }
    }
  } catch (err) {
    logger.error("Recurring-detection job failed to fetch users", {}, err);
  }

  logger.info("Recurring-detection job completed", {
    usersProcessed: totalUsers,
    recurringsSuggested: totalSuggested,
  });
};
