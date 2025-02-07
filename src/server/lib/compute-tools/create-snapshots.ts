import {
  Account,
  AccountSnapshot,
  getDateString,
  getSquashedDateString,
  Holding,
  HoldingSnapshot,
  isEqual,
  Security,
  SecuritySnapshot,
  Snapshot,
} from "common";
import {
  deleteHoldings,
  MaskedUser,
  PartialAccount,
  searchSecurities,
  upsertAccounts,
  upsertHoldings,
  upsertSecurities,
  upsertSnapshots,
} from "server";
import { getSecurityForSymbol } from "../polygon";

export const upsertAccountsWithSnapshots = async (
  user: MaskedUser,
  incomingAccounts: PartialAccount[],
  existingAccounts: Account[]
) => {
  const { user_id } = user;
  const existingMap = new Map(existingAccounts.map((a) => [a.account_id, a]));

  const snapshots: AccountSnapshot[] = incomingAccounts
    .filter((a) => {
      const existing = existingMap.get(a.account_id);
      if (!existing) return true;
      return !isEqual(existing.balances, a.balances);
    })
    .map((a) => {
      return {
        user: { user_id },
        snapshot: new Snapshot({ snapshot_id: `${a.id}-${getSquashedDateString()}` }),
        account: new Account(a),
      };
    });

  return Promise.all([upsertAccounts(user, incomingAccounts), upsertSnapshots(snapshots)]);
};

export const upsertAndDeleteHoldingsWithSnapshots = async (
  user: MaskedUser,
  incomingHoldings: Holding[],
  existingHoldings: Holding[]
) => {
  const { user_id } = user;
  const existingMap = new Map(existingHoldings.map((h) => [h.holding_id, h]));
  const incomingMap = new Map(incomingHoldings.map((h) => [h.holding_id, h]));

  const snapshots: HoldingSnapshot[] = incomingHoldings
    .filter((h) => {
      const existing = existingMap.get(h.holding_id);
      if (!existing) return true;
      return !isEqual(existing, h);
    })
    .map((h) => {
      return {
        user: { user_id },
        snapshot: new Snapshot({ snapshot_id: `${h.id}-${getSquashedDateString()}` }),
        holding: new Holding(h),
      };
    });

  const removedHoldings: Holding[] = [];

  existingHoldings
    .filter((h) => !incomingMap.has(h.holding_id))
    .forEach((h) => {
      removedHoldings.push(new Holding(h));
      snapshots.push({
        user: { user_id },
        snapshot: new Snapshot({ snapshot_id: `${h.id}-${getSquashedDateString()}` }),
        holding: new Holding({ ...h, quantity: 0, institution_value: 0 }),
      });
    });

  return Promise.all([
    upsertHoldings(user, incomingHoldings),
    upsertSnapshots(snapshots),
    deleteHoldings(user, removedHoldings),
  ]);
};

export const upsertSecuritiesWithSnapshots = async (securities: Security[]) => {
  const newSecurities: Security[] = [];
  const snapshots: SecuritySnapshot[] = [];
  const idMap: { [key: string]: string } = {};

  const promises = securities.map(async (s) => {
    const { security_id, ticker_symbol, close_price, close_price_as_of } = s;
    if (!ticker_symbol) return;
    if (!close_price || !close_price_as_of) return;

    const newSecurity = new Security(s);

    const storedSecurity = await searchSecurities({ ticker_symbol });
    if (storedSecurity.length) {
      const existingSecurity = new Security(storedSecurity[0]);
      newSecurity.security_id = existingSecurity.id;
      const snapshot_id = `${existingSecurity.id}-${getSquashedDateString()}`;

      const existingDateString = existingSecurity.close_price_as_of;
      const existingDate = existingDateString && new Date(existingDateString);
      if (existingDate) {
        if (existingDate < new Date(close_price_as_of)) {
          snapshots.push({
            snapshot: new Snapshot({ snapshot_id }),
            security: new Security(newSecurity),
          });
        } else if (existingDate < new Date(getDateString())) {
          const todaySecurity = await getSecurityForSymbol(ticker_symbol);
          if (todaySecurity) {
            newSecurity.close_price = todaySecurity.close_price;
            newSecurity.close_price_as_of = todaySecurity.close_price_as_of;
            snapshots.push({
              snapshot: new Snapshot({ snapshot_id }),
              security: new Security(newSecurity),
            });
          }
        }
      }
    } else {
      const snapshot_id = `${newSecurity.id}-${getSquashedDateString()}`;
      snapshots.push({
        snapshot: new Snapshot({ snapshot_id }),
        security: new Security(newSecurity),
      });
    }

    newSecurities.push(newSecurity);
    idMap[security_id] = newSecurity.id;
    return;
  });

  await Promise.all(promises);
  await Promise.all([upsertSecurities(newSecurities), upsertSnapshots(snapshots)]);

  return idMap;
};
