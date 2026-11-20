-- cleanup-corrupt-crypto-snapshots-777.sql
--
-- One-off cleanup for hoiekim/budget#777 (closes #777).
-- Deletes the corrupt crypto security snapshots left behind by #771 and
-- keeps the corrected refresh/backfill (#775) from having to fight them.
--
-- Background
-- ----------
-- Before #775, every Polygon price lookup passed a security's bare
-- `ticker_symbol` to the US-equity aggregates endpoint. A crypto security
-- with `type = 'cryptocurrency'` and `ticker_symbol = 'BTC'` therefore
-- resolved to the US-listed stock trading under the ticker BTC, and its
-- closes (~$26-$34) were written into `snapshots` under the Bitcoin
-- security's own `security_id` from 2026-06-09 through the #775 merge
-- (2026-09-05). The Performance widget's TWR for the affected account
-- still reads about -99.97% because `backfill-snapshots.ts` skips any
-- month that already has a snapshot and `refresh-security-snapshots.ts`
-- only writes the latest trading day, so the corrupt rows are never
-- overwritten. See #771 for the full evidence.
--
-- What this file deletes
-- ----------------------
-- `snapshot_type = 'security'` rows for `securities.type =
-- 'cryptocurrency'` whose `close_price` is more than 20x outside the
-- plausible band implied by that security's own institution-sourced
-- history (holding snapshots' `institution_price` in the same calendar
-- year), within the corruption window 2026-06-09 .. 2026-09-06. The 20x
-- ratio matches the write-time sanity gate proposed in #778: real
-- volatility, splits handled upstream, and thin instruments never trip
-- it. Securities with no institution history in 2026 are left untouched
-- (no evidence either way), as are rows outside the window.
--
-- Why a split: soft-delete most rows, hard-delete the backfill ids
-- ------------------------------------------------------------------
-- Clients cache security snapshots (in memory and IndexedDB) and evict a
-- cached row only when it arrives on the delta sync as an `is_deleted`
-- tombstone. A hard-deleted row never arrives, so a warm client would keep
-- the corrupt close indefinitely. Most candidates are therefore
-- SOFT-deleted (`is_deleted = TRUE, updated = CURRENT_TIMESTAMP`, the same
-- shape as `Table.bulkSoftDelete`), which every client receives as a
-- tombstone on its next sync.
--
-- The exception is the one id per month that backfill rewrites:
-- `${security_id}-YYYYMM15`. `upsertSnapshots` does NOT clear `is_deleted`
-- for security rows (unlike account/holding rows), so a soft-deleted row at
-- that id would receive the corrected close but stay invisible. Those ids
-- are HARD-deleted; backfill (whose `haveMonth` ignores soft-deleted rows)
-- then writes the corrected close under the same id, and that row replaces
-- the cached corrupt one on the next delta sync. If Polygon returns no data
-- for that month, the cached copy stays until the client's next cold sync.
--
-- Assumes the server runs in UTC (the container default): backfill builds
-- the id from the 15th in the server's local time zone.
--
-- How to run (the maintainer runs this on prod; never run blind)
-- ----------------------------------------------------
-- 1. Preview without writing: run the whole file with its final COMMIT
--    swapped for ROLLBACK, and eyeball every row Step 0 lists (ticker,
--    date, stored close, the institution band it was judged against, and
--    the action). If any row surprises you, stop.
--      sed 's/^COMMIT;$/ROLLBACK;/' \
--        scripts/sql/cleanup-corrupt-crypto-snapshots-777.sql \
--        | psql -v ON_ERROR_STOP=1
-- 2. Run the whole file: `psql -v ON_ERROR_STOP=1 -f
--    scripts/sql/cleanup-corrupt-crypto-snapshots-777.sql`.
-- 3. Check the Step 2 output: `remaining` must be 0. Step 3 lists any
--    crypto security snapshots outside the window that also fail the 20x
--    test — if it returns rows, the window missed corrupt writes; do not
--    widen the window silently, file a follow-up.
--
-- Idempotency: re-running the file touches 0 rows (soft-deleted rows no
-- longer match, hard-deleted rows are gone) and the Step 2 count stays 0.
-- No application code is added or changed by this file; it follows the
-- bulk-data-recovery pattern (no temporary cleanup code in the app).
--
-- Dry-run evidence: see the PR body.

BEGIN;

-- The candidate set, defined once so the preview, the DELETE, and the
-- verification can never drift apart.
CREATE TEMP VIEW corrupt_crypto_snapshots_777 AS
WITH institution_band AS (
  SELECT
    h.holding_security_id AS security_id,
    MIN(h.institution_price) AS min_price,
    MAX(h.institution_price) AS max_price
  FROM snapshots h
  WHERE h.snapshot_type = 'holding'
    AND h.holding_security_id IS NOT NULL
    AND h.institution_price IS NOT NULL
    AND h.institution_price > 0
    AND h.snapshot_date >= TIMESTAMPTZ '2026-01-01 00:00:00Z'
    AND h.snapshot_date < TIMESTAMPTZ '2027-01-01 00:00:00Z'
    AND (h.is_deleted IS NULL OR h.is_deleted = FALSE)
  GROUP BY h.holding_security_id
)
SELECT
  s.snapshot_id,
  s.security_id,
  sec.ticker_symbol,
  sec.name AS security_name,
  s.snapshot_date,
  s.close_price,
  b.min_price AS institution_min,
  b.max_price AS institution_max,
  s.snapshot_id = s.security_id || '-'
    || to_char(s.snapshot_date AT TIME ZONE 'UTC', 'YYYYMM') || '15'
    AS backfill_rewrites
FROM snapshots s
JOIN securities sec ON sec.security_id = s.security_id
JOIN institution_band b ON b.security_id = s.security_id
WHERE s.snapshot_type = 'security'
  AND sec.type = 'cryptocurrency'
  AND (s.is_deleted IS NULL OR s.is_deleted = FALSE)
  AND s.snapshot_date >= TIMESTAMPTZ '2026-06-09 00:00:00Z'
  AND s.snapshot_date < TIMESTAMPTZ '2026-09-07 00:00:00Z'
  AND s.close_price IS NOT NULL
  AND (s.close_price < b.min_price / 20 OR s.close_price > b.max_price * 20);

-- Step 0 — preview: every row Step 1 will touch, and how.
SELECT
  snapshot_id,
  ticker_symbol,
  security_name,
  snapshot_date,
  close_price,
  institution_min,
  institution_max,
  CASE WHEN backfill_rewrites THEN 'hard-delete' ELSE 'soft-delete' END
    AS action
FROM corrupt_crypto_snapshots_777
ORDER BY ticker_symbol, snapshot_date;

-- Step 1a — hard-delete the ids backfill rewrites.
DELETE FROM snapshots s
USING corrupt_crypto_snapshots_777 c
WHERE s.snapshot_id = c.snapshot_id
  AND c.backfill_rewrites;

-- Step 1b — soft-delete the rest so clients receive them as tombstones.
UPDATE snapshots s
SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
FROM corrupt_crypto_snapshots_777 c
WHERE s.snapshot_id = c.snapshot_id
  AND NOT c.backfill_rewrites;

-- Step 2 — verify: the candidate set must now be empty.
SELECT count(*) AS remaining FROM corrupt_crypto_snapshots_777;

-- Step 3 — diagnostic: crypto security snapshots OUTSIDE the window that
-- also fail the 20x test against their institution band. Expect 0 rows.
-- Any rows here mean the window missed corrupt writes; investigate before
-- widening anything.
WITH institution_band AS (
  SELECT
    h.holding_security_id AS security_id,
    MIN(h.institution_price) AS min_price,
    MAX(h.institution_price) AS max_price
  FROM snapshots h
  WHERE h.snapshot_type = 'holding'
    AND h.holding_security_id IS NOT NULL
    AND h.institution_price IS NOT NULL
    AND h.institution_price > 0
    AND h.snapshot_date >= TIMESTAMPTZ '2026-01-01 00:00:00Z'
    AND h.snapshot_date < TIMESTAMPTZ '2027-01-01 00:00:00Z'
    AND (h.is_deleted IS NULL OR h.is_deleted = FALSE)
  GROUP BY h.holding_security_id
)
SELECT
  s.snapshot_id,
  sec.ticker_symbol,
  s.snapshot_date,
  s.close_price,
  b.min_price AS institution_min,
  b.max_price AS institution_max
FROM snapshots s
JOIN securities sec ON sec.security_id = s.security_id
JOIN institution_band b ON b.security_id = s.security_id
WHERE s.snapshot_type = 'security'
  AND sec.type = 'cryptocurrency'
  AND (s.snapshot_date < TIMESTAMPTZ '2026-06-09 00:00:00Z'
    OR s.snapshot_date >= TIMESTAMPTZ '2026-09-07 00:00:00Z')
  AND s.close_price IS NOT NULL
  AND (s.close_price < b.min_price / 20 OR s.close_price > b.max_price * 20)
ORDER BY sec.ticker_symbol, s.snapshot_date;

COMMIT;
