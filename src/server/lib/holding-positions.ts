/**
 * The one derivation of a holding's positions from its transactions, shared by
 * every writer of holding snapshots.
 *
 * - Snapshots this module writes carry `DERIVED_HOLDING_SNAPSHOT_PREFIX` and a
 *   hash of the values written into their id. A snapshot with any other id,
 *   or a derived one whose values no longer match its hash (someone edited
 *   it), is a position someone entered.
 * - Positions are walked in date order over every live transaction. Each
 *   entered snapshot is a reset point: the position becomes its quantity and
 *   cost on its date, and later transactions apply on top. Sales subtract from
 *   the running position.
 * - With `replace`, entered snapshots are ignored and retired, and the holding
 *   is the transactions' alone.
 */

import { createHash } from "crypto";
import { InvestmentTransactionType } from "plaid";
import { DERIVED_HOLDING_SNAPSHOT_PREFIX, JSONInvestmentTransaction } from "common";
import {
  MaskedUser,
  QueryExecutor,
  getHoldingSnapshotsForSecurities,
  getHoldingsForSecurities,
  getInvestmentTransactionsForSecurities,
  softDeleteHoldingSnapshots,
  upsertHoldingOrThrow,
  upsertHoldingSnapshotsBatch,
} from "./postgres/repositories";
import type { HoldingSnapshot } from "./postgres/repositories";

export type Movement = Pick<JSONInvestmentTransaction, "date" | "type" | "quantity" | "amount" | "price">;

export interface StoredHoldingSnapshot {
  snapshot_id: string;
  /** YYYY-MM-DD */
  date: string;
  quantity: number;
  cost_basis: number | null;
  institution_price: number | null;
  institution_value: number | null;
}

/** A position someone entered that the walk up to its date doesn't account for. */
export interface PositionGap {
  date: string;
  stored: number;
  explained: number;
}

export interface Position {
  quantity: number;
  costBasis: number;
  price: number;
}

export interface HoldingPositionPlan {
  gaps: PositionGap[];
  /** Derived snapshots not yet stored with these values. */
  writes: HoldingSnapshot[];
  /** Snapshots to soft-delete: derived ones no longer produced, and entered ones when replacing. */
  retire: string[];
  /** The position at the latest snapshot date, for the holdings row. */
  final: { date: string; position: Position } | null;
}

const QUANTITY_EPSILON = 1e-6;
const MONEY_EPSILON = 0.005;

const squash = (date: string) => date.replaceAll("-", "");
const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

const addMonth = (yearMonth: string) => {
  const [y, m] = yearMonth.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

const round = (n: number, places: number) => Number(n.toFixed(places));

/**
 * A position rounded to the snapshot columns' scales. Written in this form,
 * the database stores exactly these values, so a row hashes the same when
 * read back.
 */
const toColumns = (p: Position): Position => ({
  quantity: round(p.quantity, 6),
  costBasis: round(p.costBasis, 2),
  price: round(p.price, 6),
});

const storedForm = (security_id: string, date: string, p: Position) => {
  const c = toColumns(p);
  return [security_id, date, c.quantity.toFixed(6), c.costBasis.toFixed(2), c.price.toFixed(6), round(c.quantity * c.price, 2).toFixed(2)];
};

export const derivedSnapshotId = (account_id: string, security_id: string, date: string, position: Position) => {
  const hash = createHash("sha256").update(storedForm(security_id, date, position).join("|")).digest("hex");
  return `${DERIVED_HOLDING_SNAPSHOT_PREFIX}${account_id}-${security_id}-${squash(date)}-${hash.slice(0, 12)}`;
};

/**
 * Whether this module wrote the snapshot and nobody has changed it since. The
 * Holding Detail edit keeps a snapshot's id, so an edit shows as values that
 * no longer hash to it.
 */
export const isUnchangedDerived = (account_id: string, security_id: string, s: StoredHoldingSnapshot) =>
  s.snapshot_id.startsWith(DERIVED_HOLDING_SNAPSHOT_PREFIX) &&
  s.snapshot_id ===
    derivedSnapshotId(account_id, security_id, s.date, {
      quantity: s.quantity,
      costBasis: s.cost_basis ?? 0,
      price: s.institution_price ?? 0,
    }) &&
  (s.institution_value ?? 0).toFixed(2) === round(s.quantity * (s.institution_price ?? 0), 2).toFixed(2);

const applyMovement = (running: { quantity: number; costBasis: number }, m: Movement) => {
  if (m.type === InvestmentTransactionType.Buy) {
    running.quantity += m.quantity;
    running.costBasis += m.amount;
  } else if (running.quantity > 0) {
    // A sale takes basis in proportion to the shares leaving, at the average
    // cost of the whole position, entered shares included.
    const sold = Math.min(Math.abs(m.quantity), running.quantity);
    running.costBasis -= (running.costBasis / running.quantity) * sold;
    running.quantity -= sold;
  }
};

/**
 * Pure: what a holding's derived snapshots and holdings row should be.
 * Snapshots go on every day with a movement, and on the 1st of every month
 * after the first one through `throughMonth` (holdings are valued from the
 * latest snapshot in each calendar month, with no carry-forward). Days with
 * an entered snapshot keep it and get no derived one.
 */
export const planHoldingPositions = (input: {
  account_id: string;
  security_id: string;
  movements: Movement[];
  stored: StoredHoldingSnapshot[];
  throughMonth: string;
  replace: boolean;
}): HoldingPositionPlan => {
  const { account_id, security_id, throughMonth, replace } = input;
  const movements = input.movements
    .filter((m) => m.type === InvestmentTransactionType.Buy || m.type === InvestmentTransactionType.Sell)
    .map((m) => ({ ...m, date: m.date.slice(0, 10) }))
    .sort(byDate);
  const derived = input.stored.filter((s) => isUnchangedDerived(account_id, security_id, s));
  const entered = input.stored
    .filter((s) => !isUnchangedDerived(account_id, security_id, s))
    .sort((a, b) => byDate(a, b) || (a.snapshot_id < b.snapshot_id ? -1 : 1));
  // Two entered snapshots on one day: the later id wins, as the read order has it.
  const enteredByDate = new Map(entered.map((s) => [s.date, s]));

  const dates = Array.from(new Set([...movements.map((m) => m.date), ...enteredByDate.keys()])).sort();
  const running = { quantity: 0, costBasis: 0 };
  let price = 0;
  let next = 0;
  const gaps: PositionGap[] = [];
  const points = new Map<string, Position>();
  for (const date of dates) {
    let moved = false;
    while (next < movements.length && movements[next].date === date) {
      const m = movements[next++];
      applyMovement(running, m);
      if (m.price > 0) price = m.price;
      moved = true;
    }
    const own = enteredByDate.get(date);
    if (own) {
      if (Math.abs(own.quantity - running.quantity) > QUANTITY_EPSILON) {
        gaps.push({ date, stored: own.quantity, explained: running.quantity });
      }
      if (!replace) {
        // An entered snapshot is the position at the end of its day.
        running.costBasis =
          own.cost_basis ?? (running.quantity > 0 ? (running.costBasis / running.quantity) * own.quantity : 0);
        running.quantity = own.quantity;
        if ((own.institution_price ?? 0) > 0) price = own.institution_price!;
      }
    }
    if (!moved && replace) continue;
    points.set(date, { quantity: running.quantity, costBasis: Math.max(0, running.costBasis), price });
  }

  const pointDates = Array.from(points.keys()).sort();
  const openings: { date: string; position: Position }[] = [];
  if (pointDates.length) {
    let i = 0;
    let last: Position | undefined;
    for (let month = addMonth(pointDates[0].slice(0, 7)); month <= throughMonth; month = addMonth(month)) {
      const first = `${month}-01`;
      while (i < pointDates.length && pointDates[i] < first) last = points.get(pointDates[i++]);
      if (last && !points.has(first)) openings.push({ date: first, position: last });
    }
  }

  const wanted = [...Array.from(points, ([date, position]) => ({ date, position })), ...openings].sort(byDate);
  const keptEntered = replace ? new Set<string>() : new Set(enteredByDate.keys());
  const storedIds = new Set(derived.map((s) => s.snapshot_id));
  const produced = new Set<string>();
  const writes: HoldingSnapshot[] = [];
  for (const { date, position: exact } of wanted) {
    if (keptEntered.has(date)) continue;
    const position = toColumns(exact);
    const snapshot_id = derivedSnapshotId(account_id, security_id, date, position);
    produced.add(snapshot_id);
    if (storedIds.has(snapshot_id)) continue;
    writes.push({
      snapshot_id,
      // Noon UTC is the same calendar day in every US time zone; midnight
      // reads as the previous day, and so the previous month, west of UTC.
      snapshot_date: `${date}T12:00:00Z`,
      holding_account_id: account_id,
      holding_security_id: security_id,
      quantity: position.quantity,
      cost_basis: position.costBasis,
      institution_price: position.price,
      institution_value: round(position.quantity * position.price, 2),
    });
  }

  const retire = [
    ...derived.filter((s) => !produced.has(s.snapshot_id)).map((s) => s.snapshot_id),
    ...(replace ? entered.map((s) => s.snapshot_id) : []),
  ];
  return { gaps, writes, retire, final: wanted.length ? wanted[wanted.length - 1] : null };
};

const toStored = (s: HoldingSnapshot): StoredHoldingSnapshot => ({
  snapshot_id: s.snapshot_id,
  date: s.snapshot_date.slice(0, 10),
  quantity: s.quantity ?? 0,
  cost_basis: s.cost_basis ?? null,
  institution_price: s.institution_price ?? null,
  institution_value: s.institution_value ?? null,
});

const planAll = (
  account_id: string,
  security_ids: string[],
  movements: Partial<JSONInvestmentTransaction>[],
  stored: HoldingSnapshot[],
  replace: Set<string>,
) => {
  const throughMonth = new Date().toISOString().slice(0, 7);
  const plans = new Map<string, HoldingPositionPlan>();
  for (const security_id of security_ids) {
    plans.set(
      security_id,
      planHoldingPositions({
        account_id,
        security_id,
        movements: movements.filter((m) => m.security_id === security_id) as Movement[],
        stored: stored.filter((s) => s.holding_security_id === security_id).map(toStored),
        throughMonth,
        replace: replace.has(security_id),
      }),
    );
  }
  return plans;
};

export interface HoldingPositionOptions {
  /** Securities whose entered positions are replaced by the transactions' figures. */
  replace?: string[];
}

/**
 * Plans the holdings without writing or locking, adding `pending` movements
 * not yet stored. For showing what a write would do.
 */
export const previewHoldingPositions = async (
  user: MaskedUser,
  account_id: string,
  security_ids: string[],
  pending: Partial<JSONInvestmentTransaction>[],
  options: HoldingPositionOptions = {},
): Promise<Map<string, HoldingPositionPlan>> => {
  if (!security_ids.length) return new Map();
  const [movements, stored] = await Promise.all([
    getInvestmentTransactionsForSecurities(user, account_id, security_ids),
    getHoldingSnapshotsForSecurities(user, account_id, security_ids),
  ]);
  return planAll(account_id, security_ids, [...movements, ...pending], stored, new Set(options.replace));
};

/**
 * Rewrites the holdings' derived snapshots and holdings rows from their live
 * transactions and entered snapshots, inside the caller's transaction.
 *
 * Takes its locks in one order, so every writer that calls this queues
 * instead of deadlocking: the holdings' investment transactions, then their
 * snapshots by date and id, then their holdings rows. Writes snapshots before
 * holdings rows, as account deletion does. Every write throws, so a failure
 * aborts the caller's transaction instead of committing part of it.
 */
export const refreshHoldingPositions = async (
  client: QueryExecutor,
  user: MaskedUser,
  account_id: string,
  security_ids: string[],
  options: HoldingPositionOptions = {},
): Promise<Map<string, HoldingPositionPlan>> => {
  if (!security_ids.length) return new Map();
  const locked = { client, forUpdate: true };
  const movements = await getInvestmentTransactionsForSecurities(user, account_id, security_ids, locked);
  const stored = await getHoldingSnapshotsForSecurities(user, account_id, security_ids, locked);
  const holdings = await getHoldingsForSecurities(user, account_id, security_ids, locked);

  const plans = planAll(account_id, security_ids, movements, stored, new Set(options.replace));
  await upsertHoldingSnapshotsBatch(user, Array.from(plans.values()).flatMap((p) => p.writes), client);
  await softDeleteHoldingSnapshots(user, Array.from(plans.values()).flatMap((p) => p.retire), client);

  const current = new Map(holdings.map((h) => [h.security_id, h]));
  for (const [security_id, plan] of plans) {
    if (!plan.final) continue;
    const { date, position } = plan.final;
    const existing = current.get(security_id);
    const unchanged =
      existing &&
      Math.abs(existing.quantity - position.quantity) <= QUANTITY_EPSILON &&
      Math.abs((existing.cost_basis ?? 0) - position.costBasis) <= MONEY_EPSILON &&
      Math.abs(existing.institution_price - position.price) <= QUANTITY_EPSILON &&
      String(existing.institution_price_as_of ?? "").slice(0, 10) === date;
    if (unchanged) continue;
    await upsertHoldingOrThrow(
      user,
      {
        holding_id: `${account_id}-${security_id}`,
        account_id,
        security_id,
        quantity: position.quantity,
        cost_basis: position.costBasis,
        institution_price: position.price,
        institution_price_as_of: date,
        institution_value: position.quantity * position.price,
        iso_currency_code: null,
        unofficial_currency_code: null,
      },
      client,
    );
  }
  return plans;
};
