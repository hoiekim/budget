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
import { withTransaction } from "../postgres/client";
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
  const upsertedIds = new Set<string>();
  if (!securities.length) return upsertedIds;

  // Process securities in a deterministic ticker-symbol order so
  // concurrent syncs that touch overlapping tickers acquire per-
  // ticker locks in the same order (deadlock avoidance under the
  // per-ticker `pg_advisory_xact_lock` below).
  const orderedInputs = [...securities].sort((a, b) =>
    (a.ticker_symbol ?? "").localeCompare(b.ticker_symbol ?? ""),
  );

  await withTransaction(async (client) => {
    const newSecurities: JSONSecurity[] = [];
    const snapshots: JSONSecuritySnapshot[] = [];

    for (const s of orderedInputs) {
      const { ticker_symbol, close_price, close_price_as_of } = s;
      if (!ticker_symbol) continue;
      if (!close_price || !close_price_as_of) continue;

      // Per-ticker transaction-scoped advisory lock. Serializes
      // concurrent syncs on the same ticker so the READ COMMITTED
      // race — sync A and sync B both `searchSecurities({ticker})`,
      // both see the same `existingId`, both remap and delete, then
      // one inserts a fresh row and the other inserts a duplicate —
      // can't happen: the second waits at the lock until the first
      // commits, then re-reads. `hashtext(...)` gives us the int-
      // keyed lock argument advisory locks require.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':security'))`, [
        ticker_symbol,
      ]);

      const newSecurity: JSONSecurity = { ...s };
      // Search runs on the default pool (Table.query doesn't take a
      // client). Correctness is preserved because the advisory lock
      // above forces any concurrent sync to commit before we get
      // here — so what we see is committed state, not an in-flight
      // remap.
      const storedSecurity = await searchSecurities({ ticker_symbol });

      if (storedSecurity.length) {
        const existingSecurity: JSONSecurity = { ...storedSecurity[0] };
        // Ticker collision on a DIFFERENT id — promote the incoming
        // id as canonical (Plaid/SimpleFin becomes source of truth)
        // and remap every DB reference from the old id to the
        // incoming one. Passes `client` so the remap participates in
        // this transaction, not its own — the eventual securities +
        // snapshot upsert below commits atomically with the remap.
        if (existingSecurity.security_id !== newSecurity.security_id) {
          await remapSecurityReferences(
            existingSecurity.security_id,
            newSecurity.security_id,
            client,
          );
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

    // Inside the same tx as the remap. If either upsert throws, the
    // whole transaction rolls back — including any remap — so the
    // partial-state window ("references pointing at an incoming id
    // that doesn't exist in `securities` yet") can't happen.
    await upsertSecurities(newSecurities, client);
    await upsertSnapshots(snapshots, client);
  });

  return upsertedIds;
};
