/**
 * Fetch full daily close-price history for VOO from Yahoo Finance's
 * chart endpoint and write it as a 3-column CSV that the FE benchmark
 * widget consumes as a static asset.
 *
 * Output: src/client/public/static-data/voo_price_history.csv served at
 * /static-data/voo_price_history.csv. Columns:
 *
 *   date,close,close_adjusted
 *
 * - `close` is the unadjusted daily close (matches Plaid's institutional
 *   `close_price` convention, which is what the benchmark widget needs
 *   for an apples-to-apples comparison with the user's MWR).
 * - `close_adjusted` is split- AND dividend-adjusted (Yahoo's adjclose).
 *   Shipped alongside in case a future total-return version of the MWR
 *   wants to switch sides without re-running this loader.
 *
 * Yahoo's chart API doesn't require auth or a crumb token (unlike the
 * older download endpoint). Single GET per ticker.
 *
 * Run: `bun scripts/fetch-voo-history.ts`
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const TICKER = "VOO";
const OUTPUT_PATH = resolve(
  import.meta.dir,
  "..",
  "src",
  "client",
  "public",
  "static-data",
  "voo_price_history.csv",
);

interface ChartResponse {
  chart: {
    error: { code?: string; description?: string } | null;
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{ close: Array<number | null> }>;
        adjclose?: Array<{ adjclose: Array<number | null> }>;
      };
    }>;
  };
}

const url = `https://query1.finance.yahoo.com/v8/finance/chart/${TICKER}?period1=0&period2=9999999999&interval=1d`;

console.log(`Fetching ${TICKER} from Yahoo chart endpoint…`);
const response = await fetch(url, {
  headers: { "User-Agent": "Mozilla/5.0" },
});
if (!response.ok) {
  throw new Error(`Yahoo returned ${response.status}: ${await response.text()}`);
}
const data = (await response.json()) as ChartResponse;
if (data.chart.error) {
  throw new Error(`Yahoo chart error: ${JSON.stringify(data.chart.error)}`);
}

const result = data.chart.result?.[0];
if (!result) throw new Error("No result in Yahoo response");

const timestamps = result.timestamp;
const closes = result.indicators.quote[0]?.close;
const adjcloses = result.indicators.adjclose?.[0]?.adjclose;
if (!timestamps || !closes || !adjcloses) {
  throw new Error("Missing timestamps / close / adjclose in Yahoo response");
}
if (timestamps.length !== closes.length || timestamps.length !== adjcloses.length) {
  throw new Error("Yahoo arrays out of sync");
}

// UTC-component date string. Yahoo's `t` is the seconds-since-epoch for
// the trading session in market time, but converting via UTC year/mo/day
// stays deterministic across server timezones.
const isoDate = (epochSec: number): string => {
  const d = new Date(epochSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const lines: string[] = ["date,close,close_adjusted"];
for (let i = 0; i < timestamps.length; i++) {
  const close = closes[i];
  const adj = adjcloses[i];
  if (close == null || adj == null) continue;
  lines.push(`${isoDate(timestamps[i])},${close.toFixed(4)},${adj.toFixed(4)}`);
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n");

console.log(`Wrote ${lines.length - 1} rows to ${OUTPUT_PATH}`);
console.log(`First: ${lines[1]}`);
console.log(`Last:  ${lines[lines.length - 1]}`);
