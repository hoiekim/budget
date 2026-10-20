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

/** Minimum settled occurrences in a run before it counts as a recurring. */
const MIN_OCCURRENCES = 3;
/**
 * A run that starts after the merchant's first charge needs one more:
 * three roughly monthly visits to a shop with an irregular history are
 * more likely chance than a bill.
 */
const MIN_OCCURRENCES_AFTER_EARLIER_CHARGES = 4;
/**
 * Every charge in a run must land within ±25% of the run's median amount.
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
/**
 * A merchant's charges split into amount clusters wherever two neighbours
 * (sorted by amount) differ by more than this ratio, so a fee or a second
 * plan billed under the same merchant can't break the main bill's run. It
 * is the widest gap a set within ±25% of its median can contain, so any
 * run that passes the amount check sits inside one cluster.
 */
const MAX_CLUSTER_STEP = (1 + AMOUNT_TOLERANCE_RATIO) / (1 - AMOUNT_TOLERANCE_RATIO);
/**
 * How far a confirmed recurring's next charge may move from its latest
 * amount and still count as the same bill at a new price ($10 → $20 or
 * $5). Wider starts admitting unrelated purchases at store-like merchants;
 * a bigger jump (an intro price ending) takes one manual "add to
 * recurring", after which the ±25% rule tracks the new price.
 */
const REPRICE_MAX_FACTOR = 2;

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

/** A zero-padded MM/DD or MM/DD/YY(YY) date that banks append to names. */
const NAME_DATE_PATTERN = /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])(?:\/\d{2}(?:\d{2})?)?\b/g;

/**
 * Normalize a merchant display string into a grouping key. Plaid merchant
 * names carry per-charge noise — domain suffixes ("NETFLIX.COM"),
 * phone-number suffixes ("Netflix 8665795717"), posting dates
 * ("Manual DB-Bkrg 07/03"), punctuation, case drift — so the key drops
 * dates, lowercases, drops punctuation, drops long digit runs
 * (reference/phone numbers) while keeping short ones ("7-Eleven" keeps
 * its 7), and drops trailing domain-suffix tokens.
 */
export const normalizeMerchantName = (raw: string): string => {
  const cleaned = raw
    .replace(NAME_DATE_PATTERN, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
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

/** Whether a bank description contains the whole merchant key, word for word. */
const descriptionNames = (name: string, key: string): boolean =>
  ` ${normalizeMerchantName(name)} `.includes(` ${key} `);

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

const isValidDate = (date: string): boolean =>
  !Number.isNaN(new Date(date + "T00:00:00").getTime());

/** Is `amount` within `ratio` of `reference`, by magnitude? */
const amountWithin = (amount: number, reference: number, ratio: number): boolean =>
  Math.abs(Math.abs(amount) - Math.abs(reference)) <= Math.abs(reference) * ratio;

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

type CadenceSpec = (typeof CADENCE_SPECS)[number];

interface QualifyingRun {
  spec: CadenceSpec;
  /** Oldest first. */
  occurrences: RecurringCandidate[];
  medianAmount: number;
}

/**
 * Split one merchant's occurrences into amount clusters: sorted by
 * magnitude, a new cluster starts wherever a neighbour is more than
 * `MAX_CLUSTER_STEP` larger.
 */
const clusterByAmount = (occurrences: RecurringCandidate[]): RecurringCandidate[][] => {
  const byAmount = [...occurrences].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  const clusters: RecurringCandidate[][] = [];
  let current: RecurringCandidate[] = [];
  for (const o of byAmount) {
    const previous = current[current.length - 1];
    if (previous && Math.abs(o.amount) > Math.abs(previous.amount) * MAX_CLUSTER_STEP) {
      clusters.push(current);
      current = [];
    }
    current.push(o);
  }
  if (current.length) clusters.push(current);
  return clusters;
};

/**
 * The longest run of a cluster's most recent occurrences that qualifies
 * as a recurring, or null. A run ends at the latest occurrence, has ≥3
 * occurrences (≥4 when the merchant has older charges at any price), every
 * consecutive interval within tolerance of one
 * cadence, every amount within ±25% of the run's median, and its latest
 * occurrence within 2× the cadence of `today`. Anything older than the
 * run (a gap, a price that has since changed, a mislabelled charge) is
 * left out rather than disqualifying the merchant.
 */
const latestQualifyingRun = (
  sortedByDate: RecurringCandidate[],
  merchantFirstDate: string,
  today: string,
): QualifyingRun | null => {
  const last = sortedByDate[sortedByDate.length - 1];
  if (!last || sortedByDate.length < MIN_OCCURRENCES) return null;
  let best: QualifyingRun | null = null;
  for (const spec of CADENCE_SPECS) {
    if (daysBetween(last.date, today) > spec.days * LAPSED_CADENCE_MULTIPLE) continue;
    let start = sortedByDate.length - 1;
    while (
      start > 0 &&
      Math.abs(daysBetween(sortedByDate[start - 1]!.date, sortedByDate[start]!.date) - spec.days) <=
        spec.toleranceDays
    ) {
      start--;
    }
    const minimumAt = (from: number) =>
      sortedByDate[from]!.date > merchantFirstDate
        ? MIN_OCCURRENCES_AFTER_EARLIER_CHARGES
        : MIN_OCCURRENCES;
    for (let from = start; sortedByDate.length - from >= minimumAt(from); from++) {
      if (best && sortedByDate.length - from <= best.occurrences.length) break;
      const occurrences = sortedByDate.slice(from);
      const absAmounts = occurrences.map((o) => Math.abs(o.amount));
      const medianAmount = medianOfSorted([...absAmounts].sort((a, b) => a - b));
      if (absAmounts.every((a) => amountWithin(a, medianAmount, AMOUNT_TOLERANCE_RATIO))) {
        best = { spec, occurrences, medianAmount };
        break;
      }
    }
  }
  return best;
};

/**
 * Group candidate transactions into recurring groups. Pure: the caller owns
 * candidate selection (pending/zero-amount/hidden-account/confirmed-transfer
 * filtering); this function only groups and qualifies.
 *
 * Occurrences group by merchant and direction (income and expense of the
 * same merchant are separate), then split into amount clusters. A merchant
 * becomes a recurring when one of its clusters has a qualifying run (see
 * `latestQualifyingRun`); the group holds that run's occurrences. When
 * several clusters qualify, the larger amount wins, so a monthly fee billed
 * beside the rent never displaces it: one merchant and direction holds at
 * most one recurring.
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
    if (!isValidDate(t.date)) continue;
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

    const merchantFirstDate = occurrences.reduce(
      (first, o) => (o.date < first ? o.date : first),
      occurrences[0]!.date,
    );
    let best: QualifyingRun | null = null;
    for (const cluster of clusterByAmount(occurrences)) {
      cluster.sort((a, b) => (a.date < b.date ? -1 : 1));
      const run = latestQualifyingRun(cluster, merchantFirstDate, todayStr);
      if (run && (!best || run.medianAmount > best.medianAmount)) best = run;
    }
    if (!best) continue;

    const first = best.occurrences[0]!;
    result.push({
      merchant_key: normalizeMerchantName(first.merchant_name || first.name || ""),
      merchant_name: mostCommon(best.occurrences.map((o) => o.merchant_name || o.name)),
      cadence: best.spec.cadence,
      is_income: first.amount < 0,
      transaction_ids: best.occurrences.map((o) => o.transaction_id),
    });
  }

  return result;
};

export interface ConfirmedRecurringSnapshot {
  merchant_key: string;
  is_income: boolean;
  cadence: RecurringCadence;
  /** The recurring's live member transactions, any order. */
  members: (Pick<RecurringCandidate, "transaction_id" | "amount" | "date"> &
    Partial<Pick<RecurringCandidate, "merchant_name">>)[];
}

type Member = ConfirmedRecurringSnapshot["members"][number];

/**
 * The cadence a recurring actually bills on: measured from its members'
 * median interval when that lands on a known cadence, else the stored one.
 * A manual recurring stores a monthly default until it has two members.
 */
const measuredSpec = (members: Member[], stored: RecurringCadence) => {
  if (members.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < members.length; i++) {
      intervals.push(daysBetween(members[i - 1]!.date, members[i]!.date));
    }
    const median = medianOfSorted(intervals.sort((a, b) => a - b));
    const measured = CADENCE_SPECS.find(
      (s) => Math.abs(median - s.days) <= s.toleranceDays,
    );
    if (measured) return measured;
  }
  return CADENCE_SPECS.find((s) => s.cadence === stored);
};

const addDays = (date: string, days: number): string => {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + Math.round(days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Pick the charges a confirmed recurring collects this run. Pure: the
 * caller resolves the members, `claimed` (transaction ids already in any
 * active recurring, this one included), and `group`, this merchant's
 * detection group (its latest qualifying run) when it has one.
 *
 * Two sources, returned together, oldest first:
 *
 * 1. The qualifying group, when it holds one of the recurring's members;
 *    otherwise it is another stream the merchant bills, at another price.
 *    Every unclaimed charge in it joins, whatever its date: detection has
 *    already checked the intervals and amounts. This is how a recurring
 *    created from one recent charge picks up its history, and how a charge
 *    that syncs late with an earlier date still lands.
 *
 * 2. New charges after the latest member, for when no qualifying group
 *    holds one (one late charge, a price change, a stray purchase). Walking
 *    forward one billing cycle at a time, a charge joins when it is due on
 *    the schedule and looks like the bill:
 *    - Due: a whole number of periods after the last due date, no more
 *      than the cadence's tolerance early and at most half a period late.
 *      A late charge moves the schedule to its due date, not its own, so
 *      the next on-time charge still fits. Among several due charges in a
 *      cycle, the one closest to the due date wins, so a same-priced
 *      purchase a few days off can't push the real charge out.
 *    - Bill-like: within ±25% of the latest member's amount, or the same
 *      bill at a new price (within 2×, on time, and repeated one period
 *      later at ±25%, so the first new-price charge joins a cycle late).
 *    A recurring with a single member has no measured cadence yet, so its
 *    next charge joins when it lands one period of any cadence later (on
 *    time); after that the measured schedule applies.
 */
export const selectConfirmedAttachments = (
  recurring: ConfirmedRecurringSnapshot,
  candidates: RecurringCandidate[],
  claimed: ReadonlySet<string>,
  group?: Pick<DetectedRecurringGroup, "transaction_ids">,
  activeKeys: ReadonlySet<string> = new Set(),
): string[] => {
  const key = recurring.merchant_key;
  // Enrichment can name a merchant something else, or nothing, from one charge
  // to the next, so a bank description that names this merchant also counts.
  // Only for a key that came from a merchant name and has more than one word:
  // a key formed from a description, or a single word, also matches whatever
  // else bills through it. A charge whose own key is another active
  // recurring's stays with that one.
  const describable =
    key.includes(" ") &&
    recurring.members.some((m) => !!m.merchant_name && normalizeMerchantName(m.merchant_name) === key);
  const belongs = (c: RecurringCandidate) => {
    const own = normalizeMerchantName(c.merchant_name || c.name || "");
    if (own === key) return true;
    return describable && !!c.name && !activeKeys.has(own) && descriptionNames(c.name, key);
  };
  const candidateById = new Map(candidates.map((c) => [c.transaction_id, c]));
  const memberIds = new Set(recurring.members.map((m) => m.transaction_id));
  const sameStream = !!group?.transaction_ids.some((id) => memberIds.has(id));
  const fromGroup = (sameStream ? group!.transaction_ids : []).filter(
    (id) => !claimed.has(id) && candidateById.has(id),
  );
  const taken = new Set([...claimed, ...fromGroup]);
  const members: Member[] = [
    ...recurring.members,
    ...fromGroup.map((id) => candidateById.get(id)!),
  ]
    .filter((m) => m.amount && isValidDate(m.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let mostRecent = members[members.length - 1];
  if (!mostRecent) return [];

  const eligible = candidates
    .filter(
      (c) =>
        !!c.amount &&
        (c.amount < 0) === recurring.is_income &&
        !taken.has(c.transaction_id) &&
        isValidDate(c.date) &&
        c.date > mostRecent!.date &&
        belongs(c),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const attached: RecurringCandidate[] = [];
  let schedule = mostRecent.date;
  for (;;) {
    const known = [...members, ...attached];
    const measured = known.length >= 2 ? measuredSpec(known, recurring.cadence) : undefined;
    if (known.length >= 2 && !measured) break;

    /** Where `date` falls on the schedule from `from`, or null if it isn't
     *  due: at most `late` days late, never more than tolerance early. */
    const due = (from: string, date: string, late: number) => {
      const gap = daysBetween(from, date);
      if (measured) {
        const periods = Math.max(1, Math.round(gap / measured.days));
        const offset = gap - periods * measured.days;
        return offset >= -measured.toleranceDays && offset <= late
          ? { periods, offset, spec: measured }
          : null;
      }
      // One member: no cadence to go by yet, so take a charge one period of
      // any cadence later.
      for (const spec of CADENCE_SPECS) {
        const offset = gap - spec.days;
        if (Math.abs(offset) <= spec.toleranceDays) return { periods: 1, offset, spec };
      }
      return null;
    };
    const lateAllowance = measured
      ? Math.max(measured.toleranceDays, measured.days / 2)
      : 0;

    let best: ({ c: RecurringCandidate } & NonNullable<ReturnType<typeof due>>) | undefined;
    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i]!;
      if (c.date <= mostRecent.date) continue;
      const timing = due(schedule, c.date, lateAllowance);
      if (!timing) continue;
      const onTime = Math.abs(timing.offset) <= timing.spec.toleranceDays;
      const sameBill = amountWithin(c.amount, mostRecent.amount, AMOUNT_TOLERANCE_RATIO);
      const factor = Math.abs(c.amount) / Math.abs(mostRecent.amount);
      const repriced =
        !sameBill &&
        onTime &&
        factor <= REPRICE_MAX_FACTOR &&
        factor >= 1 / REPRICE_MAX_FACTOR &&
        eligible.slice(i + 1).some((next) => {
          const gap = daysBetween(c.date, next.date);
          return (
            Math.abs(gap - timing.spec.days) <= timing.spec.toleranceDays &&
            amountWithin(next.amount, c.amount, AMOUNT_TOLERANCE_RATIO)
          );
        });
      if (!sameBill && !repriced) continue;
      if (
        !best ||
        timing.periods < best.periods ||
        (timing.periods === best.periods && Math.abs(timing.offset) < Math.abs(best.offset))
      ) {
        best = { c, ...timing };
      }
    }
    if (!best) break;
    attached.push(best.c);
    mostRecent = best.c;
    // A late charge keeps the schedule on its due date, so the next on-time
    // charge still fits.
    schedule =
      Math.abs(best.offset) > best.spec.toleranceDays
        ? addDays(schedule, best.periods * best.spec.days)
        : best.c.date;
  }

  return [...fromGroup.map((id) => candidateById.get(id)!), ...attached]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((c) => c.transaction_id);
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

/**
 * Resolve recurring members straight from transactions rather than from
 * the candidate list: a member added by hand can sit outside candidacy
 * (hidden account, later paired as a transfer) and still marks how far the
 * recurring has collected.
 */
const fetchMembers = async (
  userId: string,
  transactionIds: string[],
  executor: QueryExecutor,
): Promise<ConfirmedRecurringSnapshot["members"]> => {
  const result = await executor.query(
    `SELECT t.transaction_id, t.amount, t.date::text AS date, t.merchant_name
     FROM transactions t
     WHERE t.user_id = $1
       AND t.transaction_id = ANY($2::text[])
       AND (t.is_deleted IS NULL OR t.is_deleted = FALSE)`,
    [userId, transactionIds],
  );
  return result.rows.map((row) => ({
    transaction_id: row.transaction_id as string,
    amount: Number(row.amount),
    date: (row.date as string).slice(0, 10),
    merchant_name: row.merchant_name as string | null,
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
 *        - none → INSERT a suggestion, or revive the key's soft-deleted row
 *          keeping its status (a confirmed one takes only unclaimed charges)
 *        - dismissed → skip (the denylist: the user said "no" to this
 *          merchant group, not "these transactions can never recur")
 *        - suggested → refresh transaction_ids when the set changed
 *        - confirmed → left to step 4
 *   4. For each confirmed recurring, append the charges
 *      `selectConfirmedAttachments` picks: its merchant's detected group
 *      when that holds one of its members, plus new charges due on its
 *      schedule. This is how a confirmed recurring collects each new charge.
 */
export const runRecurringDetection = async (): Promise<void> => {
  logger.info("Recurring-detection job started");

  let totalUsers = 0;
  let totalSuggested = 0;
  let totalAttached = 0;

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

        const rows = await recurringsTable.query(
          { [USER_ID]: userId },
          { excludeDeleted: false },
          client,
        );
        const existing = rows.filter((r) => !r.is_deleted);
        const existingByKey = new Map(
          existing.map((r) => [`${r.merchant_key}::${r.is_income}`, r]),
        );
        const deletedByKey = new Map(
          rows.filter((r) => r.is_deleted).map((r) => [`${r.merchant_key}::${r.is_income}`, r]),
        );

        // Charges already in an active recurring, and those recurrings' keys.
        const active = existing.filter((r) => r.status !== "dismissed");
        const claimed = new Set(active.flatMap((r) => r.transaction_ids));
        const activeKeys = new Set(active.map((r) => r.merchant_key));

        let userSuggested = 0;
        let userAttached = 0;
        for (const group of groups) {
          const key = `${group.merchant_key}::${group.is_income}`;
          const row = existingByKey.get(key);

          if (!row) {
            // The unique key also covers soft-deleted rows: a merchant whose
            // recurring was cascade-deleted revives that row with the new
            // charges and its status, name and default label as they were, so
            // a dismissal still holds and a confirmed recurring carries on.
            // Either way it takes only charges no active recurring holds, as
            // attaching does, and a suggestion still needs enough of them.
            const revivesConfirmed = deletedByKey.get(key)?.status === "confirmed";
            const ids = group.transaction_ids.filter((id) => !claimed.has(id));
            if (ids.length === 0 || (!revivesConfirmed && ids.length < MIN_OCCURRENCES)) continue;
            const inserted = await client.query<{ recurring_id: string; status: string }>(
              `INSERT INTO ${RECURRINGS}
                 (${RECURRING_ID}, ${USER_ID}, ${MERCHANT_KEY}, ${MERCHANT_NAME}, ${CADENCE}, ${IS_INCOME}, ${STATUS}, ${TRANSACTION_IDS})
               VALUES ($1, $2, $3, $4, $5, $6, 'suggested', $7)
               ON CONFLICT (${USER_ID}, ${MERCHANT_KEY}, ${IS_INCOME}) DO UPDATE SET
                 ${CADENCE} = EXCLUDED.${CADENCE},
                 ${TRANSACTION_IDS} = EXCLUDED.${TRANSACTION_IDS},
                 ${IS_DELETED} = FALSE,
                 ${UPDATED} = CURRENT_TIMESTAMP
               WHERE ${RECURRINGS}.${IS_DELETED} = TRUE
               RETURNING ${RECURRING_ID}, ${STATUS}`,
              [
                crypto.randomUUID(),
                userId,
                group.merchant_key,
                group.merchant_name,
                group.cadence,
                group.is_income,
                ids,
              ],
            );
            const revived = inserted.rows[0];
            if (revived && revived.status !== "dismissed") ids.forEach((id) => claimed.add(id));
            if (revived?.status === "suggested") userSuggested++;
            if (revived?.status === "confirmed") {
              await labelConfirmedRecurring(client, userId, revived.recurring_id, ids);
              userAttached += ids.length;
            }
            continue;
          }

          if (row.status === "dismissed") continue;

          if (row.status === "suggested") {
            // Refresh membership when the detected set changed (new
            // charges arrived, or deleted ones fell out of candidacy).
            // No UPDATE when identical — avoids `updated` churn that
            // would spam delta syncs with no-op bumps. The name is left
            // alone: the user may have renamed the suggestion. A charge
            // another active recurring holds stays there.
            const ids = group.transaction_ids.filter(
              (id) => !claimed.has(id) || row.transaction_ids.includes(id),
            );
            if (!sameIdSet(row.transaction_ids, ids)) {
              await client.query(
                `UPDATE ${RECURRINGS}
                 SET ${TRANSACTION_IDS} = $2, ${CADENCE} = $3, ${UPDATED} = CURRENT_TIMESTAMP
                 WHERE ${RECURRING_ID} = $1`,
                [row.recurring_id, ids, group.cadence],
              );
            }
            ids.forEach((id) => claimed.add(id));
            continue;
          }
        }

        // Confirmed: attach each new charge. Runs per row rather than per
        // group, so a merchant whose history no longer qualifies (one late
        // charge, a price change, a stray purchase), or a manual recurring
        // that never did, keeps collecting. A row revived above isn't in
        // `existing`; its charges are already in `claimed`, and it collects
        // from the next run on.
        const confirmed = existing.filter((r) => r.status === "confirmed");
        if (confirmed.length > 0) {
          const members = await fetchMembers(
            userId,
            confirmed.flatMap((r) => r.transaction_ids),
            executor,
          );
          const memberById = new Map(members.map((m) => [m.transaction_id, m]));
          const groupByKey = new Map(
            groups.map((g) => [`${g.merchant_key}::${g.is_income}`, g]),
          );
          for (const row of confirmed) {
            const fresh = selectConfirmedAttachments(
              {
                merchant_key: row.merchant_key,
                is_income: row.is_income,
                cadence: row.cadence,
                members: row.transaction_ids.flatMap((id) => {
                  const member = memberById.get(id);
                  return member ? [member] : [];
                }),
              },
              candidates,
              claimed,
              groupByKey.get(`${row.merchant_key}::${row.is_income}`),
              activeKeys,
            );
            if (fresh.length === 0) continue;
            await client.query(
              `UPDATE ${RECURRINGS}
               SET ${TRANSACTION_IDS} = ${TRANSACTION_IDS} || $2::text[],
                   ${UPDATED} = CURRENT_TIMESTAMP
               WHERE ${RECURRING_ID} = $1`,
              [row.recurring_id, fresh],
            );
            // New charges take the recurring's default label.
            await labelConfirmedRecurring(client, userId, row.recurring_id, fresh);
            for (const id of fresh) claimed.add(id);
            userAttached += fresh.length;
          }
        }

        await client.query("COMMIT");
        totalUsers++;
        totalSuggested += userSuggested;
        totalAttached += userAttached;
        if (userSuggested > 0 || userAttached > 0) {
          logger.info("Updated recurrings for user", {
            userId,
            suggested: userSuggested,
            attached: userAttached,
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
    chargesAttached: totalAttached,
  });
};
