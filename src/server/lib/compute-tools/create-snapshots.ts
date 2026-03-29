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
  searchSecurities,
  upsertAccounts,
  upsertHoldings,
  upsertSecurities,
  upsertSnapshots,
} from "server";
import { getSecurityForSymbol } from "../polygon";
import { logger } from "../logger";

/**
 * Detects duplicate accounts from the same Plaid item (e.g. co-branded cards
 * reported as two separate accounts with identical balances and type).
 *
 * Detection criteria: two or more accounts share the same item_id, type,
 * balances.current, balances.available, and balances.limit.
 *
 * Resolution: keep the account with a custom_name (user-configured) as visible.
 * If none have a custom_name, keep the first and hide the rest. Accounts the
 * user has already explicitly hidden are left unchanged.
 *
 * Only applies to accounts that are NEW (not yet stored), to avoid overriding
 * deliberate user hide/show choices on previously-seen accounts.
 */
export const detectAndHideDuplicateAccounts = (
  incomingAccounts: JSONAccount[],
  existingAccounts: JSONAccount[],
): JSONAccount[] => {
  const existingIds = new Set(existingAccounts.map((a) => a.account_id));

  // Build a fingerprint key from the fields that identify a duplicate
  const fingerprint = (a: JSONAccount): string => {
    const cur = a.balances.current ?? "null";
    const avail = a.balances.available ?? "null";
    const limit = a.balances.limit ?? "null";
    return `${a.item_id}|${a.type}|${cur}|${avail}|${limit}`;
  };

  // Group accounts by fingerprint
  const groups = new Map<string, JSONAccount[]>();
  for (const account of incomingAccounts) {
    const key = fingerprint(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(account);
  }

  const result: JSONAccount[] = [];
  for (const [, group] of groups) {
    if (group.length < 2) {
      result.push(...group);
      continue;
    }

    // Multiple accounts with identical fingerprint — detect duplicates.
    // Find the "preferred" account: one with a custom_name, or first in list.
    const preferred =
      group.find((a) => a.custom_name && a.custom_name.trim() !== "") ?? group[0];

    for (const account of group) {
      // Skip accounts that already exist in the DB — user may have set hide explicitly
      if (existingIds.has(account.account_id)) {
        result.push(account);
        continue;
      }
      if (account.account_id === preferred!.account_id) {
        result.push(account);
      } else {
        logger.info("Auto-hiding duplicate Plaid account", {
          accountId: account.account_id,
          name: account.name,
          preferredId: preferred!.account_id,
          itemId: account.item_id,
        });
        result.push({ ...account, hide: true });
      }
    }
  }

  return result;
};

export const upsertAccountsWithSnapshots = async (
  user: MaskedUser,
  incomingAccounts: JSONAccount[],
  existingAccounts: JSONAccount[],
) => {
  const { user_id } = user;
  const existingMap = new Map(existingAccounts.map((a) => [a.account_id, a]));

  // Auto-hide duplicate accounts from the same Plaid item before persisting.
  // Only affects new accounts (not yet in the DB) to preserve user preferences.
  const deduplicatedAccounts = detectAndHideDuplicateAccounts(incomingAccounts, existingAccounts);

  const snapshots: JSONAccountSnapshot[] = deduplicatedAccounts
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

  await upsertAccounts(user, deduplicatedAccounts);
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
    idMap[security_id] = newSecurity.security_id;
    return;
  });

  await Promise.all(promises);
  await upsertSecurities(newSecurities);
  await upsertSnapshots(snapshots);

  return idMap;
};
