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
 * Upsert incoming securities from a sync (Plaid, SimpleFin) and write a
 * per-day security snapshot for each. The incoming `security_id` is
 * treated as identity — no ticker-collision dedupe. When a user has
 * previously minted a security row for the same ticker (via
 * `/api/validate-ticker`) and Plaid later syncs its own row for the
 * same ticker, both survive as separate `securities` rows.
 *
 * That's intentional: HoldingsComposition buckets by ticker (not by
 * security_id), so the FE aggregates the two into one visual row and
 * users don't see the internal duplication. The pre-dedupe behavior
 * (`newSecurity.security_id = existingSecurity.security_id`) caused
 * an orphan-reference bug — Plaid's holdings were written with
 * Plaid's raw security_id but the securities table was rewritten
 * against the user-minted id, leaving holdings pointing at a row
 * that no longer existed. Skipping dedupe removes the bug in one
 * line.
 *
 * Returns the set of successfully-upserted `security_id`s so callers
 * (`sync-simple-fin.ts` in particular) can drop holdings whose security
 * was filtered out here (no ticker or no close price).
 */
export const upsertSecuritiesWithSnapshots = async (
  securities: JSONSecurity[],
): Promise<Set<string>> => {
  const newSecurities: JSONSecurity[] = [];
  const snapshots: JSONSecuritySnapshot[] = [];
  const upsertedIds = new Set<string>();

  for (const s of securities) {
    const { ticker_symbol, close_price, close_price_as_of } = s;
    if (!ticker_symbol) continue;
    if (!close_price || !close_price_as_of) continue;

    const newSecurity: JSONSecurity = { ...s };
    const snapshot_id = `${newSecurity.security_id}-${getSquashedDateString()}`;
    snapshots.push({
      snapshot: { snapshot_id, date: new Date().toISOString() },
      security: newSecurity,
    });

    newSecurities.push(newSecurity);
    upsertedIds.add(newSecurity.security_id);
  }

  await upsertSecurities(newSecurities);
  await upsertSnapshots(snapshots);
  return upsertedIds;
};
