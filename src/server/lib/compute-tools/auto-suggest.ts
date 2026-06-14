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
  /** Sum of per-row feature counts across the user's confirmed history
   *  matching at least one feature of the target. A row that hit 4
   *  features contributes 4×; a row that hit 1 feature contributes 1×.
   *  Naturally amplifies multi-feature agreement without a separate
   *  scoring pass. */
  accepted: number;
  /** Same shape on `rejected_categories`. A rejection that's tied to a
   *  transaction matching 3 features of the target contributes 3 to the
   *  rejected score — preserves the symmetry with accepted. */
  rejected: number;
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
// that confirmation with its own 0.95-0.99 suggestion and replace the
// user's chosen `category_id` / `budget_id` with the engine's pick.
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
 *   primary, day-of-month band). A historical row qualifies if it matches
 *   on AT LEAST ONE feature; its score is the count of features it
 *   matched (1..7). SUM(score) per category — the natural amplification.
 * - If enough signal (>= 3 labeled, <= 10% reject rate, >= 95% confidence
 *   for best category), apply the suggestion with confidence = accepted /
 *   total (capped at 0.99).
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

// Score a per-target signal against the gates. Returns the capped
// confidence to apply (in [0, 1)), or null if any gate fails.
const evaluateSignal = (signal: FeatureSignal): number | null => {
  const totalLabeled = signal.accepted + signal.rejected;
  if (totalLabeled < 3) return null;
  const rejectRate = signal.rejected / totalLabeled;
  if (rejectRate > 0.1) return null;
  const confidence = signal.accepted / totalLabeled;
  if (confidence < 0.95) return null;
  // Cap at 0.99 — 1.0 is reserved for user-confirmed labels.
  return Math.min(confidence, 0.99);
};

const processUserSuggestions = async (userId: string): Promise<number> => {
  let suggested = 0;

  // No per-merchant cache anymore — the signal depends on the full
  // feature set of EACH target, so two unlabeled transactions with the
  // same merchant but different amounts / channels would (correctly)
  // get different signals. Cache hit rate would be near-zero and a
  // stale cache would produce wrong predictions. Per-target queries
  // are cheap (one round-trip each) and bounded by the 7-day unlabeled
  // window.

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
 * `rejected_categories`). Each feature contributes 1 to the row's score
 * if it matches the target; the SQL `SUM(score)` then aggregates per
 * category — multi-feature agreement amplifies naturally.
 *
 * The `t` alias must point at the row whose features are being scored
 * (the historical `transactions` row in both code paths). Parameter
 * indexes match the call site's `params` array.
 */
const SCORE_EXPR = (t: string) => `(
  (CASE WHEN $2::text IS NOT NULL AND ${t}.merchant_name IS NOT NULL
        AND similarity(${t}.merchant_name, $2) >= $3 THEN 1 ELSE 0 END)
+ (CASE WHEN $4::text IS NOT NULL AND ${t}.name IS NOT NULL
        AND similarity(${t}.name, $4) >= $3 THEN 1 ELSE 0 END)
+ (CASE WHEN ${t}.amount BETWEEN $5 AND $6 THEN 1 ELSE 0 END)
+ (CASE WHEN $7::text IS NOT NULL AND ${t}.payment_channel = $7 THEN 1 ELSE 0 END)
+ (CASE WHEN ${t}.account_id = $8 THEN 1 ELSE 0 END)
+ (CASE WHEN $9::text IS NOT NULL
        AND (${t}.raw->'personal_finance_category'->>'primary') = $9 THEN 1 ELSE 0 END)
+ (CASE WHEN EXTRACT(DAY FROM ${t}.date::date) BETWEEN $10 AND $11 THEN 1 ELSE 0 END)
)`;

const getFeatureSignal = async (
  userId: string,
  f: TargetFeatures,
): Promise<FeatureSignal | null> => {
  // Single SELECT per call — winner CTE picks the category whose summed
  // per-row feature score is highest across the user's confirmed
  // history. A historical row only counts if it matches at least one
  // feature (the WHERE row-filter `score > 0`). The rejected subquery
  // applies the identical score expression to `rejected_categories ⋈
  // transactions` so the gate compares apples-to-apples.
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
       SELECT label_category_id, SUM(score)::int AS accepted
       FROM scored
       WHERE score > 0
       GROUP BY label_category_id
       ORDER BY accepted DESC
       LIMIT 1
     )
     SELECT
       w.label_category_id,
       sections.budget_id AS label_budget_id,
       w.accepted,
       (
         SELECT COALESCE(SUM(${SCORE_EXPR("t")})::int, 0)
         FROM rejected_categories rc
         JOIN transactions t
           ON t.transaction_id = rc.transaction_id
           AND t.user_id = rc.user_id
         WHERE rc.user_id = $1
           AND rc.category_id = w.label_category_id
           AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)
           AND ${SCORE_EXPR("t")} > 0
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
    rejected: string;
  };
  return {
    label_category_id: row.label_category_id,
    label_budget_id: row.label_budget_id,
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
  };
};
