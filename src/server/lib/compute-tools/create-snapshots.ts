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
} from "common";
import {
  deleteHoldings,
  MaskedUser,
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
  await deleteHoldings(user, removedHoldings);
};

export const upsertSecuritiesWithSnapshots = async (securities: JSONSecurity[]) => {
  const newSecurities: JSONSecurity[] = [];
  const snapshots: JSONSecuritySnapshot[] = [];
  const idMap: { [key: string]: string } = {};

  const promises = securities.map(async (s) => {
    const { security_id, ticker_symbol, close_price, close_price_as_of } = s;
    if (!ticker_symbol) return;
    if (!close_price || !close_price_as_of) return;

    const newSecurity: JSONSecurity = { ...s };

    const storedSecurity = await searchSecurities({ ticker_symbol });
    if (storedSecurity.length) {
      const existingSecurity: JSONSecurity = { ...storedSecurity[0] };
      newSecurity.security_id = existingSecurity.security_id;
      const snapshot_id = `${existingSecurity.security_id}-${getSquashedDateString()}`;

      const existingDateString = existingSecurity.close_price_as_of;
      const existingDate = existingDateString && new Date(existingDateString);
      if (existingDate) {
        if (existingDate < new Date(close_price_as_of)) {
          snapshots.push({
            snapshot: { snapshot_id, date: new Date().toISOString() },
            security: newSecurity,
          });
        } else if (existingDate < new Date(getDateString())) {
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
    idMap[security_id] = newSecurity.security_id;
    return;
  });

  await Promise.all(promises);
  await upsertSecurities(newSecurities);
  await upsertSnapshots(snapshots);

  return idMap;
};
