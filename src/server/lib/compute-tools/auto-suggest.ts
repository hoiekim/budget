import {
  pool,
  logger,
  usersTable,
  transactionsTable,
  splitTransactionsTable,
  AdditionalWhere,
} from "server";

// Compare-and-swap guard for both the transactions and split-transactions
// UPDATEs. The engine must only overwrite a row that is STILL unlabeled
// (`label_category_confidence IS NULL`) — never a row a user just confirmed
// (confidence = 1) between the fetch and the per-row apply. Lifted to a named
// exported constant so:
//   1. it's grep-able when reviewing changes to the suggestion path;
//   2. tests can assert both apply sites thread this exact reference, not
//      a silently-altered inline literal.
export const CAS_NULL_CONFIDENCE: AdditionalWhere = {
  column: "label_category_confidence",
  value: null,
};

/** pg_trgm similarity threshold for `merchant_name` / `name` matching.
 *  0.5 is a balanced default for short, dirty Plaid identifiers. */
const TEXT_SIMILARITY_THRESHOLD = 0.5;

/** Tolerance on the amount band: matches historical transactions whose
 *  amount lies in (target * 0.8, target * 1.2). Sign-preserving — a
 *  negative target only matches negative historicals in the same band. */
const AMOUNT_BAND_TOLERANCE = 0.2;

/** ±3 days around the target's day-of-month. Captures most monthly-
 *  recurring patterns (rent, subscriptions, paychecks) without losing
 *  every match when the date falls on a weekend / holiday. */
const DAY_BAND_TOLERANCE = 3;

/** Per-feature weights for the per-row scoring expression. Weights
 *  reflect each feature's discriminative power and were tuned against
 *  the prod-clone E2E evaluation set:
 *
 *    - merchant_name: 100  → uniquely identifies a merchant; the
 *      single strongest signal. Most user labels are merchant-driven.
 *    - name: 50            → near-duplicate of merchant_name in most
 *      cases, but informative when they diverge.
 *    - plaid_pfc_primary: 10 → coarse but Plaid-curated category;
 *      strong fallback when the merchant is unseen.
 *    - amount band: 5      → recurring-amount patterns (rent, subs)
 *      and amount-class patterns ($5 vs $500 vs $5000).
 *    - payment_channel: 1, account_id: 1, day_band: 1 → low
 *      discriminative power (only 3 channels, ~3 accounts, ±3 days
 *      covers 20% of the month) — keep at 1 so they break ties
 *      between high-merchant categories.
 *
 *  Weights are large enough that a row matching merchant alone (100)
 *  beats a row matching all three weak features (3) by 33×. This is
 *  what prevents category volume from drowning out feature quality. */
const W_MERCHANT_NAME = 100;
const W_NAME = 50;
const W_PFC = 10;
const W_AMOUNT = 5;
const W_PAYMENT_CHANNEL = 1;
const W_ACCOUNT = 1;
const W_DAY = 1;

/** Minimum per-row score for a historical confirmed row to count as a
 *  meaningful match. A score of 15 means the row matched at least one
 *  identity-like signal — e.g., merchant alone (100), name alone (50),
 *  or pfc + amount + a weak feature (16). Rows that ONLY matched the
 *  weak feature trio (amount + channel + day = 7, account-only = 1)
 *  are coincidences, not signal, and would otherwise drown out real
 *  matches by volume. Tuned against the prod-clone evaluation sweep:
 *  raising from 8 → 15 nearly doubled recall without losing precision. */
const ROW_SCORE_THRESHOLD = 15;

/** Minimum quality (avg per-row score / max-possible-per-row) before
 *  the engine writes a suggestion. Quality measures HOW STRONG the
 *  average match is, not how many matches exist. A null-merchant
 *  target whose entire matching pool is "name match + amount" averages
 *  ~50% of max possible; a target with extensive merchant history
 *  averages 80%+. 0.30 sits below the typical "true signal" floor
 *  and above the "weak-coincidence" ceiling — sweep optimum. */
const MIN_QUALITY = 0.30;

/** Lower bound of the engine-written confidence. Matches `MIN_QUALITY`'s
 *  floor — a suggestion that just barely passes the gate ships at 0.5,
 *  giving downstream UX a "weakly confident" signal. */
const ENGINE_CONFIDENCE_FLOOR = 0.5;

/** Upper bound of the engine-written confidence. Stays below the 0.99
 *  reservation for the API `/api/suggest-category` endpoint and well
 *  below the 1.0 reserved for user-confirmed labels. A perfect-match
 *  signal ships at 0.98. */
const ENGINE_CONFIDENCE_CEIL = 0.98;

/** A target transaction's features, pre-extracted for the per-row
 *  scoring SQL. Optional fields fall back to NULL — the SQL treats NULL
 *  as "this feature doesn't contribute" so a target with no
 *  `merchant_name` (e.g., some SimpleFin / manual rows) still scores on
 *  the other six features. */
interface TargetFeatures {
  merchant_name: string | null;
  name: string | null;
  amount: number;
  /** Lower bound of the amount band (sign-preserving). */
  amount_lo: number;
  /** Upper bound of the amount band (sign-preserving). */
  amount_hi: number;
  payment_channel: string | null;
  account_id: string;
  /** Plaid's `personal_finance_category.primary` extracted from
   *  `transactions.raw`. Null when the row came from SimpleFin or a
   *  manual upload. */
  plaid_pfc_primary: string | null;
  /** Day-of-month band's lower bound. May be < 1 — clamped naturally
   *  by `EXTRACT(DAY FROM date)` only ever returning [1..31]. */
  day_lo: number;
  day_hi: number;
}

interface FeatureSignal {
  label_category_id: string;
  // The category's parent section's parent budget. Carried alongside the
  // category so the suggestion writes `transactions.label_budget_id` too.
  // Without it the row's category select in the UI renders blank — the
  // dropdown's options are filtered by the row's `label_budget_id` (or
  // the account default), and a category whose actual parent budget is
  // neither of those is missing from the option list.
  label_budget_id: string;
  /** Sum of per-row weighted feature scores across the user's confirmed
   *  history, restricted to rows whose per-row score cleared
   *  `ROW_SCORE_THRESHOLD`. Multi-feature agreement amplifies naturally
   *  via the weights. */
  accepted: number;
  /** Symmetric weighted sum on `rejected_categories` ⋈ `transactions`
   *  (also threshold-gated). The accept/reject gate compares two
   *  numbers from the same formula. */
  rejected: number;
  /** Number of historical confirmed rows that cleared the per-row
   *  threshold AND ended up in the winning category. Used to compute
   *  the quality metric: `accepted / (count_matched × max_per_row)`. */
  count_matched: number;
  /** Maximum per-row score the target could possibly receive — sum of
   *  the weights for features the target has populated. A null-merchant
   *  target's max excludes the W_MERCHANT_NAME = 100 weight; a target
   *  with no Plaid PFC excludes W_PFC = 10. The quality metric divides
   *  `accepted` by `count_matched × max_per_row` to measure average
   *  per-row match quality — independent of category volume. */
  max_per_row: number;
}

interface UnlabeledTransaction {
  transaction_id: string;
  features: TargetFeatures;
}

interface UnlabeledSplit {
  split_transaction_id: string;
  features: TargetFeatures;
}

const featuresFromRow = (row: Record<string, unknown>): TargetFeatures => {
  const amount = (row.amount as number) ?? 0;
  const lo = amount * (1 - AMOUNT_BAND_TOLERANCE);
  const hi = amount * (1 + AMOUNT_BAND_TOLERANCE);
  const day = new Date((row.date as string) ?? new Date()).getUTCDate();
  const raw = (row.raw as Record<string, unknown>) || {};
  const pfc = (raw.personal_finance_category as Record<string, unknown>) || {};
  return {
    merchant_name: (row.merchant_name as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    amount,
    amount_lo: Math.min(lo, hi),
    amount_hi: Math.max(lo, hi),
    payment_channel: (row.payment_channel as string | null) ?? null,
    account_id: row.account_id as string,
    plaid_pfc_primary: (pfc.primary as string | null) ?? null,
    day_lo: day - DAY_BAND_TOLERANCE,
    day_hi: day + DAY_BAND_TOLERANCE,
  };
};

/** Sum the weights of features the target has populated. A null
 *  feature can never match, so its weight can never contribute — the
 *  quality denominator must exclude it to keep the metric in [0, 1]. */
const maxPerRowFor = (f: TargetFeatures): number => {
  let max = W_AMOUNT + W_ACCOUNT + W_DAY; // always-present features
  if (f.merchant_name) max += W_MERCHANT_NAME;
  if (f.name) max += W_NAME;
  if (f.payment_channel) max += W_PAYMENT_CHANNEL;
  if (f.plaid_pfc_primary) max += W_PFC;
  return max;
};

const fetchUnlabeled = async (userId: string): Promise<UnlabeledTransaction[]> => {
  const rows = await transactionsTable.query({
    user_id: userId,
    label_category_confidence: null,
  });
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  return rows
    .filter((r) => new Date(r.date as string) > oneWeekAgo)
    .map((r) => ({
      transaction_id: r.transaction_id as string,
      features: featuresFromRow(r as unknown as Record<string, unknown>),
    }));
};

// Compare-and-swap: the UPDATE only matches rows that are STILL unlabeled
// (`label_category_confidence IS NULL`). Between the unlabeled fetch and
// this per-row call, a user may have confirmed the row in the UI (writing
// `confidence = 1`). Without the IS-NULL guard, the engine would overwrite
// that confirmation with its own sub-1.0 suggestion and replace the user's
// chosen `category_id` / `budget_id` with the engine's pick.
const applyLabel = async (
  transactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
): Promise<void> => {
  await transactionsTable.update(
    transactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
    undefined,
    [CAS_NULL_CONFIDENCE],
  );
};

// Splits have no merchant_name / name / amount / channel / etc. of their
// own — they inherit from their parent transaction via
// `split_transactions.transaction_id`. The fetch joins to the parent so
// every feature comes from the parent row, matching how a user mentally
// categorizes splits. Closes #334.
const fetchUnlabeledSplits = async (userId: string): Promise<UnlabeledSplit[]> => {
  const result = await pool.query(
    `SELECT st.split_transaction_id,
            t.merchant_name, t.name, t.amount, t.payment_channel, t.account_id,
            t.raw, t.date
       FROM split_transactions st
       JOIN transactions t
         ON t.transaction_id = st.transaction_id
        AND t.user_id = st.user_id
      WHERE st.user_id = $1
        AND st.label_category_confidence IS NULL
        AND (st.is_deleted IS NULL OR st.is_deleted = FALSE)
        AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
        AND t.date > NOW() - INTERVAL '1 week'`,
    [userId],
  );
  return result.rows.map((r) => ({
    split_transaction_id: r.split_transaction_id as string,
    features: featuresFromRow(r as Record<string, unknown>),
  }));
};

// Same CAS guard as `applyLabel` — the IS-NULL clause prevents the engine
// from clobbering a user-confirmed split that flipped from null → 1.0
// between the fetch and the per-row apply.
const applyLabelToSplit = async (
  splitTransactionId: string,
  userId: string,
  labelCategoryId: string,
  labelBudgetId: string,
  labelCategoryConfidence: number,
): Promise<void> => {
  await splitTransactionsTable.update(
    splitTransactionId,
    {
      label_category_id: labelCategoryId,
      label_budget_id: labelBudgetId,
      label_category_confidence: labelCategoryConfidence,
    },
    undefined,
    userId,
    undefined,
    [CAS_NULL_CONFIDENCE],
  );
};

/**
 * Runs auto-suggestion for transaction categories based on historical
 * multi-feature patterns.
 *
 * Logic:
 * - For each user, find transactions with no category confidence
 *   (never labeled) in the last 7 days.
 * - For each unlabeled transaction, query the user's confirmed history
 *   across seven features (merchant_name fuzzy, name fuzzy, amount band,
 *   payment_channel, account_id, plaid `personal_finance_category`
 *   primary, day-of-month band). Per-row score is the weighted sum of
 *   matching features (W_MERCHANT_NAME=100, W_NAME=50, W_PFC=10,
 *   W_AMOUNT=5, the rest at 1).
 * - Only rows whose score clears `ROW_SCORE_THRESHOLD` contribute —
 *   filters out coincidental weak-only matches. SUM(score) per category
 *   picks the winner.
 * - Apply the suggestion if all three gates pass: `count_matched >= 3`
 *   (sample size), `rejected / (accepted + rejected) <= 0.1` (reject
 *   rate), `accepted / (count_matched × max_per_row) >= MIN_QUALITY`
 *   (per-row match strength). Stored confidence is the quality value
 *   itself, clamped to [ENGINE_CONFIDENCE_FLOOR, ENGINE_CONFIDENCE_CEIL]
 *   = [0.5, 0.98] — variable so downstream UX can render "weakly
 *   confident" vs "strongly confident" without re-deriving.
 *
 * Direct SQL is reserved for the feature-signal query, which uses pg_trgm
 * `similarity(...)` and a cross-table count (transactions +
 * rejected_categories) that the standard Table helpers cannot express.
 */
export const runAutoSuggestions = async (): Promise<void> => {
  logger.info("Auto-suggestion job started");

  let totalUsersProcessed = 0;
  let totalSuggested = 0;

  try {
    const users = await usersTable.query({});
    const userIds = users.map((u) => u.user_id);

    for (const user_id of userIds) {
      try {
        const suggested = await processUserSuggestions(user_id);
        totalSuggested += suggested;
        totalUsersProcessed++;
      } catch (error) {
        logger.error("Auto-suggestion failed for user", { userId: user_id }, error);
      }
    }
  } catch (error) {
    logger.error("Auto-suggestion job failed to fetch users", {}, error);
  }

  logger.info("Auto-suggestion job completed", {
    usersProcessed: totalUsersProcessed,
    transactionsSuggested: totalSuggested,
  });
};

// Score a per-target signal against the three gates:
//
//   1. Count gate — at least 3 historical confirmed rows must have
//      cleared the per-row threshold and ended up in the winning
//      category. Sample-size floor.
//
//   2. Reject rate — weighted rejection score must be < 10% of the
//      accept/reject total. The user explicitly rejected this category
//      for similar transactions; back off.
//
//   3. Quality — average per-row score across the winning category's
//      matched rows must be at least `MIN_QUALITY` of the maximum
//      possible. Below the floor means the signal is dominated by
//      weak-feature coincidences rather than identity-feature matches.
//
// When all three pass, the stored confidence is the quality value
// itself, clamped to [ENGINE_CONFIDENCE_FLOOR, ENGINE_CONFIDENCE_CEIL].
// This preserves "strength of evidence" through to downstream UX
// while keeping engine writes inside the contract band (below 0.99
// API reservation, below 1.0 user-confirmed).
const evaluateSignal = (signal: FeatureSignal): number | null => {
  if (signal.count_matched < 3) return null;
  const totalLabeled = signal.accepted + signal.rejected;
  if (totalLabeled > 0 && signal.rejected / totalLabeled > 0.1) return null;
  const quality = signal.accepted / (signal.count_matched * signal.max_per_row);
  if (quality < MIN_QUALITY) return null;
  return Math.max(ENGINE_CONFIDENCE_FLOOR, Math.min(ENGINE_CONFIDENCE_CEIL, quality));
};

const processUserSuggestions = async (userId: string): Promise<number> => {
  let suggested = 0;

  // One signal query per unlabeled target. The signal depends on the
  // full target feature set — two unlabeled transactions with the same
  // merchant but different amounts / channels get different signals —
  // so a per-merchant cache would produce wrong predictions. The
  // unlabeled pool is bounded by the 7-day window in `fetchUnlabeled`.

  // Pass 1: top-level transactions.
  const unlabeled = await fetchUnlabeled(userId);
  for (const { transaction_id, features } of unlabeled) {
    const signal = await getFeatureSignal(userId, features);
    if (!signal) continue;
    const cappedConfidence = evaluateSignal(signal);
    if (cappedConfidence === null) continue;
    await applyLabel(
      transaction_id,
      userId,
      signal.label_category_id,
      signal.label_budget_id,
      cappedConfidence,
    );
    suggested++;
  }

  // Pass 2: split transactions. Closes #334.
  const unlabeledSplits = await fetchUnlabeledSplits(userId);
  for (const { split_transaction_id, features } of unlabeledSplits) {
    const signal = await getFeatureSignal(userId, features);
    if (!signal) continue;
    const cappedConfidence = evaluateSignal(signal);
    if (cappedConfidence === null) continue;
    await applyLabelToSplit(
      split_transaction_id,
      userId,
      signal.label_category_id,
      signal.label_budget_id,
      cappedConfidence,
    );
    suggested++;
  }

  if (suggested > 0) {
    logger.info("Auto-suggested categories for user", { userId, suggested });
  }

  return suggested;
};

/**
 * Build the per-row scoring expression for either ACCEPTED (against
 * `transactions`) or REJECTED (against `transactions` joined to
 * `rejected_categories`). Each feature contributes its weight to the
 * row's score if it matches the target; the SQL `SUM(score)` then
 * aggregates per category. Weighted multi-feature agreement amplifies
 * naturally — a row matching merchant + name + amount contributes
 * 100+50+5 = 155, vs a row matching only weak features (channel +
 * account + day) at 1+1+1 = 3.
 *
 * The `t` alias must point at the row whose features are being scored
 * (the historical `transactions` row in both code paths). Parameter
 * indexes match the call site's `params` array.
 */
const SCORE_EXPR = (t: string) => `(
  (CASE WHEN $2::text IS NOT NULL AND ${t}.merchant_name IS NOT NULL
        AND similarity(${t}.merchant_name, $2) >= $3 THEN ${W_MERCHANT_NAME} ELSE 0 END)
+ (CASE WHEN $4::text IS NOT NULL AND ${t}.name IS NOT NULL
        AND similarity(${t}.name, $4) >= $3 THEN ${W_NAME} ELSE 0 END)
+ (CASE WHEN ${t}.amount BETWEEN $5 AND $6 THEN ${W_AMOUNT} ELSE 0 END)
+ (CASE WHEN $7::text IS NOT NULL AND ${t}.payment_channel = $7 THEN ${W_PAYMENT_CHANNEL} ELSE 0 END)
+ (CASE WHEN ${t}.account_id = $8 THEN ${W_ACCOUNT} ELSE 0 END)
+ (CASE WHEN $9::text IS NOT NULL
        AND (${t}.raw->'personal_finance_category'->>'primary') = $9 THEN ${W_PFC} ELSE 0 END)
+ (CASE WHEN EXTRACT(DAY FROM ${t}.date::date) BETWEEN $10 AND $11 THEN ${W_DAY} ELSE 0 END)
)`;

const getFeatureSignal = async (
  userId: string,
  f: TargetFeatures,
): Promise<FeatureSignal | null> => {
  // Per-row score = weighted sum of feature matches (see
  // W_MERCHANT_NAME, W_NAME, etc.). SUM(score) per category, winner =
  // highest total. The weights are large enough that high-quality
  // matches dominate category volume — a single merchant+name match
  // (150) beats 50 weak-feature-only matches (50 × 3 = 150) on a tie,
  // and decisively beats it after one more strong feature.
  //
  // Symmetric on the rejected side: same SCORE_EXPR is applied to
  // (rejected_categories ⋈ transactions) so the accept/reject gate
  // compares two numbers from the same formula.
  const params = [
    userId, //                       $1
    f.merchant_name, //              $2 (or null)
    TEXT_SIMILARITY_THRESHOLD, //    $3
    f.name, //                       $4 (or null)
    f.amount_lo, //                  $5
    f.amount_hi, //                  $6
    f.payment_channel, //            $7 (or null)
    f.account_id, //                 $8
    f.plaid_pfc_primary, //          $9 (or null)
    f.day_lo, //                     $10
    f.day_hi, //                     $11
    ROW_SCORE_THRESHOLD, //          $12
  ];

  const result = await pool.query(
    `WITH scored AS (
       SELECT t.label_category_id,
              ${SCORE_EXPR("t")} AS score
       FROM transactions t
       WHERE t.user_id = $1
         AND t.label_category_confidence = 1.0
         AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
     ),
     winning AS (
       SELECT label_category_id,
              SUM(score)::int AS accepted,
              COUNT(*)::int AS count_matched
       FROM scored
       WHERE score > $12
       GROUP BY label_category_id
       ORDER BY accepted DESC
       LIMIT 1
     )
     SELECT
       w.label_category_id,
       sections.budget_id AS label_budget_id,
       w.accepted,
       w.count_matched,
       (
         SELECT COALESCE(SUM(${SCORE_EXPR("t")})::int, 0)
         FROM rejected_categories rc
         JOIN transactions t
           ON t.transaction_id = rc.transaction_id
           AND t.user_id = rc.user_id
         WHERE rc.user_id = $1
           AND rc.category_id = w.label_category_id
           AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
           AND ${SCORE_EXPR("t")} > $12
       ) AS rejected
     FROM winning w
     JOIN categories ON categories.category_id = w.label_category_id
     JOIN sections ON sections.section_id = categories.section_id
     LIMIT 1`,
    params,
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as {
    label_category_id: string;
    label_budget_id: string;
    accepted: string;
    count_matched: string;
    rejected: string;
  };
  return {
    label_category_id: row.label_category_id,
    label_budget_id: row.label_budget_id,
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
    count_matched: Number(row.count_matched),
    max_per_row: maxPerRowFor(f),
  };
};
