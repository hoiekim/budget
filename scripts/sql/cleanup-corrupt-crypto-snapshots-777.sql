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
-- Why a hard DELETE, not a soft-delete
-- ------------------------------------
-- Security snapshot ids are deterministic
-- (`${security_id}-${YYYYMMDD}`), and `upsertSnapshots` does NOT clear
-- `is_deleted` for security rows (unlike account/holding rows, which
-- explicitly revive tombstones). A soft-deleted row would keep
-- `is_deleted = TRUE` while receiving the corrected close on
-- repopulation, staying invisible to every reader — and the refresh
-- cadence gate even comments on the resulting soft-deleted-snapshot
-- loop. Hard-deleting frees the month, so the next backfill/refresh
-- repopulates it from Polygon's crypto namespace (`X:BTCUSD`).
--
-- How to run (the maintainer runs this on prod; never run blind)
-- ----------------------------------------------------
-- 1. Run Step 0 (the preview SELECT) on its own first and eyeball every
--    row it lists: ticker, date, stored close, and the institution band
--    it was judged against. If any row surprises you, stop — do not run
--    the DELETE.
-- 2. Run the whole file: `psql -v ON_ERROR_STOP=1 -f
--    scripts/sql/cleanup-corrupt-crypto-snapshots-777.sql`.
-- 3. Check the Step 2 output: `remaining` must be 0. Step 3 lists any
--    crypto security snapshots outside the window that also fail the 20x
--    test — if it returns rows, the window missed corrupt writes; do not
--    widen the window silently, file a follow-up.
--
-- Idempotency: re-running the file deletes 0 rows (the rows are gone) and
-- the Step 2 count stays 0. No application code is added or changed by
-- this file; it follows the bulk-data-recovery pattern (no temporary
-- cleanup code in the app).
--
-- Dry-run evidence (scratch Postgres 16.15 DB seeded with rows mirroring
-- #771's evidence): the preview listed exactly 7 rows (the 6 corrupt
-- in-band BTC closes plus one high-side row priced about 25x above the
-- institution maximum), the DELETE
-- removed exactly those 7, the verification count was 0, and a second run
-- deleted 0 rows (idempotent). 8 security rows survived untouched
-- (pre-band institution closes, the post-fix 2026-09-08 close, the USDT
-- $1 close, the no-history DOGE close, an equity-ETF close, and the NULL
-- close). Step 3 flagged exactly 1 out-of-band row (2026-05-15, $28)
-- for follow-up. See the PR body for the full counts.

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
  sec.ticker_symbol,
  sec.name AS security_name,
  s.snapshot_date,
  s.close_price,
  b.min_price AS institution_min,
  b.max_price AS institution_max
FROM snapshots s
JOIN securities sec ON sec.security_id = s.security_id
JOIN institution_band b ON b.security_id = s.security_id
WHERE s.snapshot_type = 'security'
  AND sec.type = 'cryptocurrency'
  AND s.snapshot_date >= TIMESTAMPTZ '2026-06-09 00:00:00Z'
  AND s.snapshot_date < TIMESTAMPTZ '2026-09-07 00:00:00Z'
  AND s.close_price IS NOT NULL
  AND (s.close_price < b.min_price / 20 OR s.close_price > b.max_price * 20);

-- Step 0 — preview: every row the DELETE below will remove.
SELECT
  snapshot_id,
  ticker_symbol,
  security_name,
  snapshot_date,
  close_price,
  institution_min,
  institution_max
FROM corrupt_crypto_snapshots_777
ORDER BY ticker_symbol, snapshot_date;

-- Step 1 — delete exactly the previewed rows.
DELETE FROM snapshots s
USING corrupt_crypto_snapshots_777 c
WHERE s.snapshot_id = c.snapshot_id;

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
