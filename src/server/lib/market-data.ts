/**
 * Market-data provider policy: Polygon is the primary source; Yahoo Finance
 * (keyless) is the fallback for symbols Polygon answers `no_data` on —
 * chiefly mutual funds, which never touch an exchange tape.
 *
 * Only an empty answer is a verdict on the symbol, so every other Polygon
 * failure (rate-limited, refused, unconfigured) surfaces as-is and never
 * triggers the fallback — same rule the validate-ticker route already
 * applies to keep a sick lookup from mislabeling a good ticker.
 */

import { JSONSecurity } from "common";
import { logger } from "./logger";
import * as polygon from "./polygon";
import * as yahoo from "./yahoo";

interface DetailOptions {
  maxWaitMs?: number;
  securityType?: JSONSecurity["type"];
}

type PriceOptions = DetailOptions;

interface RangeOptions extends DetailOptions {
  lookbackDays?: number;
}

const noteFallback = (fn: string, ticker_symbol: string) => {
  logger.info(`market-data: Polygon had no data for ${ticker_symbol}; falling back to Yahoo (${fn})`, {
    component: "market-data",
  });
};

export const getTickerDetailWithFallback = async (
  ticker_symbol: string,
  options: DetailOptions = {},
): Promise<polygon.PolygonResult<polygon.TickerDetail>> => {
  const primary = await polygon.getTickerDetail(ticker_symbol, options);
  if (primary.success || primary.error !== "no_data") return primary;
  noteFallback("getTickerDetail", ticker_symbol);
  return yahoo.getTickerDetail(ticker_symbol, options);
};

export const getClosePriceWithFallback = async (
  ticker_symbol: string,
  date: Date,
  options: PriceOptions = {},
): Promise<polygon.PolygonResult<number>> => {
  const primary = await polygon.getClosePrice(ticker_symbol, date, options);
  if (primary.success || primary.error !== "no_data") return primary;
  noteFallback("getClosePrice", ticker_symbol);
  return yahoo.getClosePrice(ticker_symbol, date, options);
};

export const getLatestClosePriceOnOrBeforeWithFallback = async (
  ticker_symbol: string,
  dateOrString: Date | string,
  options: RangeOptions = {},
): Promise<polygon.PolygonResult<{ price: number; tradingDate: string }>> => {
  const primary = await polygon.getLatestClosePriceOnOrBefore(ticker_symbol, dateOrString, options);
  if (primary.success || primary.error !== "no_data") return primary;
  noteFallback("getLatestClosePriceOnOrBefore", ticker_symbol);
  return yahoo.getLatestClosePriceOnOrBefore(ticker_symbol, dateOrString, options);
};
