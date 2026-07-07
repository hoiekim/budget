import {
  JSONAccount,
  JSONAccountSnapshot,
  getDateString,
  getSquashedDateString,
  JSONHolding,
  JSONHoldingSnapshot,
  isEqual,
  JSONSecurity,
  JSONSecuritySnapshot,
  LocalDate,
} from "common";
import {
  deleteHoldings,
  MaskedUser,
  remapSecurityReferences,
  searchSecurities,
  upsertAccounts,
  upsertHoldings,
  upsertSecurities,
  upsertSnapshots,
} from "server";
import { getSecurityForSymbol } from "../polygon";

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
 * Upsert incoming securities from a sync (Plaid, SimpleFin). The
 * incoming `security_id` is treated as the canonical identity — when
 * an existing row with the same ticker carries a DIFFERENT id (a
 * user-minted UUID that predates the arrival of the provider's own
 * ID), the DB references to the old id are repointed to the incoming
 * one and the old row is deleted (`remapSecurityReferences`). Then
 * the incoming row is upserted normally. Returns the set of
 * successfully-upserted `security_id`s so callers can filter their
 * holdings list to just the securities that actually landed.
 */
export const upsertSecuritiesWithSnapshots = async (
  securities: JSONSecurity[],
): Promise<Set<string>> => {
  const newSecurities: JSONSecurity[] = [];
  const snapshots: JSONSecuritySnapshot[] = [];
  const upsertedIds = new Set<string>();

  // Remaps must run sequentially — two concurrent remaps against the
  // same old_id would race on the DELETE. Snapshot-fetch and date
  // decisions can still parallelize via .map, but the remap +
  // collection step is awaited in-order below.
  for (const s of securities) {
    const { ticker_symbol, close_price, close_price_as_of } = s;
    if (!ticker_symbol) continue;
    if (!close_price || !close_price_as_of) continue;

    const newSecurity: JSONSecurity = { ...s };
    const storedSecurity = await searchSecurities({ ticker_symbol });

    if (storedSecurity.length) {
      const existingSecurity: JSONSecurity = { ...storedSecurity[0] };
      // Ticker collision on a DIFFERENT id — promote the incoming id
      // as canonical (Plaid becomes source of truth) and remap every
      // DB reference from the old id to the incoming one.
      if (existingSecurity.security_id !== newSecurity.security_id) {
        await remapSecurityReferences(existingSecurity.security_id, newSecurity.security_id);
      }

      const snapshot_id = `${newSecurity.security_id}-${getSquashedDateString()}`;
      const existingDateString = existingSecurity.close_price_as_of;
      const existingDate = existingDateString && new LocalDate(existingDateString);
      if (existingDate) {
        if (existingDate < new LocalDate(close_price_as_of)) {
          snapshots.push({
            snapshot: { snapshot_id, date: new Date().toISOString() },
            security: newSecurity,
          });
        } else if (existingDate < new LocalDate(getDateString())) {
          const todaySecurity = await getSecurityForSymbol(ticker_symbol);
          if (todaySecurity) {
            newSecurity.close_price = todaySecurity.close_price;
            newSecurity.close_price_as_of = todaySecurity.close_price_as_of;
            snapshots.push({
              snapshot: { snapshot_id, date: new Date().toISOString() },
              security: newSecurity,
            });
          }
        }
      }
    } else {
      const snapshot_id = `${newSecurity.security_id}-${getSquashedDateString()}`;
      snapshots.push({
        snapshot: { snapshot_id, date: new Date().toISOString() },
        security: newSecurity,
      });
    }

    newSecurities.push(newSecurity);
    upsertedIds.add(newSecurity.security_id);
  }

  await upsertSecurities(newSecurities);
  await upsertSnapshots(snapshots);

  return upsertedIds;
};
