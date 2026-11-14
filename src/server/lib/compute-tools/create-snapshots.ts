import {
  JSONAccount,
  JSONAccountSnapshot,
  getSquashedDateString,
  JSONHolding,
  JSONHoldingSnapshot,
  isEqual,
  JSONSecurity,
  JSONSecuritySnapshot,
} from "common";
import {
  deleteHoldings,
  MaskedUser,
  upsertAccounts,
  upsertHoldings,
  upsertSecurities,
  upsertSnapshots,
} from "server";

export const upsertAccountsWithSnapshots = async (
  user: MaskedUser,
  incomingAccounts: JSONAccount[],
  existingAccounts: JSONAccount[],
) => {
  const { user_id } = user;
  const existingMap = new Map(existingAccounts.map((a) => [a.account_id, a]));

  const snapshots: JSONAccountSnapshot[] = incomingAccounts
    .filter((a) => {
      const existing = existingMap.get(a.account_id);
      if (!existing) return true;
      return !isEqual(existing.balances, a.balances);
    })
    .map((a) => {
      return {
        user: { user_id },
        snapshot: {
          snapshot_id: `${a.account_id}-${getSquashedDateString()}`,
          date: new Date().toISOString(),
        },
        account: { ...a },
      };
    });

  await upsertAccounts(user, incomingAccounts);
  await upsertSnapshots(snapshots);

  return;
};

export const upsertAndDeleteHoldingsWithSnapshots = async (
  user: MaskedUser,
  incomingHoldings: JSONHolding[],
  existingHoldings: JSONHolding[],
) => {
  const { user_id } = user;
  const existingMap = new Map(existingHoldings.map((h) => [h.holding_id, h]));
  const incomingMap = new Map(incomingHoldings.map((h) => [h.holding_id, h]));
  const accountIds = new Set(incomingHoldings.map((e) => e.account_id));

  const snapshots: JSONHoldingSnapshot[] = incomingHoldings
    .filter((h) => {
      const existing = existingMap.get(h.holding_id);
      if (!existing) return true;
      return !isEqual(existing, h);
    })
    .map((h) => {
      return {
        user: { user_id },
        snapshot: {
          snapshot_id: `${h.holding_id}-${getSquashedDateString()}`,
          date: new Date().toISOString(),
        },
        holding: h,
      };
    });

  const removedHoldings: JSONHolding[] = [];

  existingHoldings
    .filter((h) => accountIds.has(h.account_id) && !incomingMap.has(h.holding_id))
    .forEach((h) => {
      removedHoldings.push(h);
      snapshots.push({
        user: { user_id },
        snapshot: {
          snapshot_id: `${h.holding_id}-${getSquashedDateString()}`,
          date: new Date().toISOString(),
        },
        holding: { ...h, quantity: 0, institution_value: 0 },
      });
    });

  await upsertHoldings(user, incomingHoldings);
  await upsertSnapshots(snapshots);
  const removedHoldingIds = removedHoldings.map((h) => h.holding_id);
  await deleteHoldings(user, removedHoldingIds);
};

/**
 * Which date a security's price snapshot is filed under.
 * - `closePriceAsOf`: the trading day the provider says its close is for. Plaid's
 *   `close_price_as_of` is often the previous trading day.
 * - `syncTime`: the moment of the sync, for providers whose `close_price_as_of`
 *   isn't a price date (SimpleFIN fills it with the holding's creation time).
 * Crypto always uses `syncTime`: it trades around the clock, so its price is
 * current as of the sync, whatever date the provider attaches to it.
 */
export type PriceSnapshotDate = "closePriceAsOf" | "syncTime";

const PRICE_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Upsert incoming securities and write a price snapshot for each, dated per
 * `priceDate`. `security_id` is treated as identity — two rows can share a ticker
 * (user-minted + provider-synced), and `HoldingsComposition` folds them
 * by ticker on read. Returns the set of successfully-upserted
 * `security_id`s so callers can drop holdings whose security was
 * filtered out here (no ticker or no close price).
 */
export const upsertSecuritiesWithSnapshots = async (
  securities: JSONSecurity[],
  priceDate: PriceSnapshotDate = "syncTime",
): Promise<Set<string>> => {
  const newSecurities: JSONSecurity[] = [];
  const snapshots: JSONSecuritySnapshot[] = [];
  const upsertedIds = new Set<string>();

  for (const s of securities) {
    const { ticker_symbol, close_price, close_price_as_of } = s;
    if (!ticker_symbol) continue;
    if (!close_price || !close_price_as_of) continue;

    const newSecurity: JSONSecurity = { ...s };
    let snapshot: JSONSecuritySnapshot["snapshot"];
    if (priceDate === "closePriceAsOf" && s.type !== "cryptocurrency") {
      // Built from the date string itself, in the daily refresh's format, so no
      // server timezone can move the row to a neighbouring day.
      const day = PRICE_DATE.exec(close_price_as_of)?.[0];
      if (!day) continue;
      snapshot = { snapshot_id: `${newSecurity.security_id}-${day.replaceAll("-", "")}`, date: `${day}T12:00:00.000Z` };
    } else {
      snapshot = {
        snapshot_id: `${newSecurity.security_id}-${getSquashedDateString()}`,
        date: new Date().toISOString(),
      };
    }
    snapshots.push({ snapshot, security: newSecurity });

    newSecurities.push(newSecurity);
    upsertedIds.add(newSecurity.security_id);
  }

  await upsertSecurities(newSecurities);
  await upsertSnapshots(snapshots);
  return upsertedIds;
};
