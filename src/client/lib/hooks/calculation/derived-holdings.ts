import {
  DERIVED_HOLDING_SNAPSHOT_PREFIX,
  EnteredPosition,
  Movement,
  derivePositions,
  getYearMonthString,
  isDerivedPositionTransactionId,
} from "common";
import { HoldingSnapshotDictionary, InvestmentTransactionDictionary } from "../../models/Data";
import { Holding } from "../../models/miscellaneous";
import { HoldingSnapshot, Snapshot } from "../../models/Snapshot";

const squash = (date: string) => date.replaceAll("-", "");

/**
 * The holding snapshots, plus positions derived from transactions for every
 * holding that has imported rows: one on each day with a movement and on the
 * 1st of each later month, as holdings are valued from the latest snapshot in
 * a month. Days with an entered snapshot keep it. The derived ones live only
 * in memory; editing one on the holding page saves it as an entered snapshot.
 */
export const withDerivedHoldingSnapshots = (
  holdingSnapshots: HoldingSnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  today = new Date(),
): HoldingSnapshotDictionary => {
  const throughMonth = getYearMonthString(today);
  if (
    last &&
    last.holdingSnapshots === holdingSnapshots &&
    last.investmentTransactions === investmentTransactions &&
    last.throughMonth === throughMonth
  ) {
    return last.result;
  }
  const result = deriveHoldingSnapshots(holdingSnapshots, investmentTransactions, throughMonth);
  last = { holdingSnapshots, investmentTransactions, throughMonth, result };
  return result;
};

/**
 * The last answer, so a recalculation that changed neither input (a budget or
 * label edit) keeps the same dictionary and the memos reading it don't rerun.
 */
let last: {
  holdingSnapshots: HoldingSnapshotDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  throughMonth: string;
  result: HoldingSnapshotDictionary;
} | null = null;

const deriveHoldingSnapshots = (
  holdingSnapshots: HoldingSnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  throughMonth: string,
): HoldingSnapshotDictionary => {
  const movementsByHolding = new Map<string, Movement[]>();
  const derivedHoldings = new Set<string>();
  investmentTransactions.forEach((t) => {
    if (!t.security_id) return;
    const key = `${t.account_id}\0${t.security_id}`;
    const movements = movementsByHolding.get(key) ?? [];
    movements.push(t);
    movementsByHolding.set(key, movements);
    if (isDerivedPositionTransactionId(t.investment_transaction_id)) derivedHoldings.add(key);
  });
  if (!derivedHoldings.size) return holdingSnapshots;

  const enteredByHolding = new Map<string, EnteredPosition[]>();
  holdingSnapshots.forEach(({ snapshot, holding }) => {
    const key = `${holding.account_id}\0${holding.security_id}`;
    if (!derivedHoldings.has(key)) return;
    const entered = enteredByHolding.get(key) ?? [];
    entered.push({
      snapshot_id: snapshot.snapshot_id,
      date: snapshot.date.slice(0, 10),
      quantity: holding.quantity,
      cost_basis: holding.cost_basis ?? null,
      institution_price: holding.institution_price ?? null,
    });
    enteredByHolding.set(key, entered);
  });

  const result = new HoldingSnapshotDictionary(holdingSnapshots);
  for (const key of derivedHoldings) {
    const [account_id, security_id] = key.split("\0");
    const entered = enteredByHolding.get(key) ?? [];
    const enteredDates = new Set(entered.map((e) => e.date));
    const { positions } = derivePositions({
      movements: movementsByHolding.get(key) ?? [],
      entered,
      throughMonth,
    });
    for (const { date, position } of positions) {
      if (enteredDates.has(date)) continue;
      const snapshot_id = `${DERIVED_HOLDING_SNAPSHOT_PREFIX}${account_id}-${security_id}-${squash(date)}`;
      result.set(
        snapshot_id,
        new HoldingSnapshot({
          // Noon UTC is the same calendar day in every US time zone.
          snapshot: new Snapshot({ snapshot_id, date: `${date}T12:00:00.000Z` }),
          // The holding's id is the one its stored snapshots carry, so a month with an
          // entered snapshot and a derived position counts the holding once.
          holding: new Holding({
            account_id,
            security_id,
            quantity: position.quantity,
            cost_basis: position.costBasis,
            institution_price: position.price,
            institution_price_as_of: date,
            institution_value: position.quantity * position.price,
          }),
        }),
      );
    }
  }
  return result;
};

export const isDerivedHoldingSnapshot = (snapshot: HoldingSnapshot) =>
  snapshot.snapshot.snapshot_id.startsWith(DERIVED_HOLDING_SNAPSHOT_PREFIX);
