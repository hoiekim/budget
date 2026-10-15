/**
 * The one derivation of a holding's positions from its transactions, shared by
 * the client (which values holdings from it) and the server's reinvestment job
 * (which needs the shares held on an ex-date).
 *
 * Positions are walked in date order over every live buy and sell. Each
 * entered holding snapshot is a reset point: the position becomes its quantity
 * and cost at the end of its day, and later transactions apply on top. Sales
 * subtract from the running position. With `replace`, entered snapshots are
 * ignored and the holding is the transactions' alone.
 */

import { InvestmentTransactionType } from "plaid";
import { JSONInvestmentTransaction } from "./models";
import { PLAN_STATEMENT_ID_PREFIX } from "./constants";

export type Movement = Pick<JSONInvestmentTransaction, "date" | "type" | "quantity" | "amount" | "price"> &
  Partial<Pick<JSONInvestmentTransaction, "investment_transaction_id">>;

/** A holding snapshot someone entered. */
export interface EnteredPosition {
  snapshot_id: string;
  /** YYYY-MM-DD */
  date: string;
  quantity: number;
  cost_basis: number | null;
  institution_price: number | null;
}

/** An entered position the walk up to its date doesn't account for. */
export interface PositionGap {
  date: string;
  stored: number;
  explained: number;
}

export interface Position {
  quantity: number;
  /** Null when an entered position with no cost basis left it unknown. */
  costBasis: number | null;
  price: number;
}

export interface DatedPosition {
  date: string;
  position: Position;
}

/** Whether a holding with this transaction has its positions derived from its transactions. */
export const isDerivedPositionTransactionId = (investment_transaction_id: string) =>
  investment_transaction_id.startsWith(PLAN_STATEMENT_ID_PREFIX);

const QUANTITY_EPSILON = 1e-6;

const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const byId = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);
/** Within a day, shares arrive before any leave, so a same-day sale isn't capped at what came earlier. */
const buysFirst = (a: Movement, b: Movement) =>
  Number(a.type !== InvestmentTransactionType.Buy) - Number(b.type !== InvestmentTransactionType.Buy);

const addMonth = (yearMonth: string) => {
  const [y, m] = yearMonth.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

const applyMovement = (running: { quantity: number; costBasis: number | null }, m: Movement) => {
  if (m.type === InvestmentTransactionType.Buy) {
    running.quantity += m.quantity;
    if (running.costBasis !== null) running.costBasis += m.amount;
  } else if (running.quantity > 0) {
    // A sale takes basis in proportion to the shares leaving, at the average
    // cost of the whole position, entered shares included.
    const sold = Math.min(Math.abs(m.quantity), running.quantity);
    if (running.costBasis !== null) running.costBasis -= (running.costBasis / running.quantity) * sold;
    running.quantity -= sold;
  }
};

/** The entered position the walk resets to on each date; on a day with two, the later id wins. */
export const enteredResetPoints = (entered: EnteredPosition[]): Map<string, EnteredPosition> =>
  new Map(
    [...entered]
      .sort((a, b) => byDate(a, b) || byId(a.snapshot_id, b.snapshot_id))
      .map((s) => [s.date, s]),
  );

interface Walk {
  gaps: PositionGap[];
  /** The position at the end of each walked day. */
  points: Map<string, Position>;
  /** The position after the last walked day. */
  running: { quantity: number; costBasis: number | null };
}

/**
 * Every buy and sell in date order (within a day, buys before sells, then by
 * id), each entered
 * position a reset point at the end of its day unless `replace`, stopping
 * before `before` when given.
 */
const walkPositions = (input: {
  movements: Movement[];
  entered: EnteredPosition[];
  replace?: boolean;
  before?: string;
}): Walk => {
  const { replace = false, before } = input;
  const movements = input.movements
    .filter((m) => m.type === InvestmentTransactionType.Buy || m.type === InvestmentTransactionType.Sell)
    .map((m) => ({ ...m, date: m.date.slice(0, 10) }))
    .sort((a, b) => byDate(a, b) || buysFirst(a, b) || byId(a.investment_transaction_id, b.investment_transaction_id));
  const enteredByDate = enteredResetPoints(input.entered);

  const dates = Array.from(new Set([...movements.map((m) => m.date), ...enteredByDate.keys()]))
    .sort()
    .filter((date) => before === undefined || date < before);
  const running: { quantity: number; costBasis: number | null } = { quantity: 0, costBasis: 0 };
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
      const explained = Math.abs(own.quantity - running.quantity) <= QUANTITY_EPSILON;
      if (!explained) gaps.push({ date, stored: own.quantity, explained: running.quantity });
      if (!replace) {
        // An entered position is the holding at the end of its day. With no
        // cost of its own, the cost stays what the walk knows only if the walk
        // already explains its shares; otherwise it's unknown until a later
        // entry gives one.
        running.costBasis = own.cost_basis ?? (explained ? running.costBasis : null);
        running.quantity = own.quantity;
        if ((own.institution_price ?? 0) > 0) price = own.institution_price!;
      }
    }
    if (!moved && replace) continue;
    points.set(date, {
      quantity: running.quantity,
      costBasis: running.costBasis === null ? null : Math.max(0, running.costBasis),
      price,
    });
  }
  return { gaps, points, running };
};

/** The position held at the start of `date`: earlier days' movements, entered positions as end-of-day resets. */
export const positionBefore = (input: {
  movements: Movement[];
  entered: EnteredPosition[];
  date: string;
}): { quantity: number; costBasis: number | null } => {
  const { running } = walkPositions({ ...input, before: input.date });
  return { quantity: running.quantity, costBasis: running.costBasis === null ? null : Math.max(0, running.costBasis) };
};

/**
 * A holding's positions from its transactions: one on every day with a
 * movement or an entry, and one on the 1st of every later month through
 * `throughMonth` (holdings are valued from the latest position in each
 * calendar month, with no carry-forward). Also the entered positions the
 * transactions don't explain.
 */
export const derivePositions = (input: {
  movements: Movement[];
  entered: EnteredPosition[];
  /** YYYY-MM */
  throughMonth: string;
  replace?: boolean;
}): { gaps: PositionGap[]; positions: DatedPosition[] } => {
  const { gaps, points } = walkPositions(input);
  const pointDates = Array.from(points.keys()).sort();
  const openings: DatedPosition[] = [];
  if (pointDates.length) {
    let i = 0;
    let last: Position | undefined;
    for (let month = addMonth(pointDates[0].slice(0, 7)); month <= input.throughMonth; month = addMonth(month)) {
      const first = `${month}-01`;
      while (i < pointDates.length && pointDates[i] < first) last = points.get(pointDates[i++]);
      if (last && !points.has(first)) openings.push({ date: first, position: last });
    }
  }
  const positions = [...Array.from(points, ([date, position]) => ({ date, position })), ...openings].sort(byDate);
  return { gaps, positions };
};
