/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString, getDateTimeString, getRandomId, JSONSecurity } from "common";
import { logger } from "./logger";

const POLYGON_HOST = "https://api.polygon.io";
const { POLYGON_API_KEY } = process.env;

export const getClosePrice = async (ticker_symbol: string, date: Date) => {
  const dateString = getDateString(date);
  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${ticker_symbol}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/v2/aggs/${tickerParameter}/${rangeParameter}?apiKey=${POLYGON_API_KEY}`;
  const { results } = await fetch(path)
    .then((r) => r.json())
    .catch((error) => {
      logger.warn("Failed to fetch close price from Polygon", { ticker: ticker_symbol, date: dateString }, error);
      return {};
    });
  if (!results) return undefined;
  // c = close price
  return results[0].c as number;
};

export const getTickerDetail = async (ticker_symbol: string) => {
  const path = `${POLYGON_HOST}/v3/reference/tickers/${ticker_symbol}?apiKey=${POLYGON_API_KEY}`;
  const { results } = await fetch(path)
    .then((r) => r.json())
    .catch((error) => {
      logger.warn("Failed to fetch ticker detail from Polygon", { ticker: ticker_symbol }, error);
      return {};
    });
  if (!results) return undefined;
  const name = results.name as string;
  const currency_name = results.currency_name as string;
  return { ticker_symbol, name, currency_name };
};

export const getSecurityForSymbol = async (
  ticker_symbol: string,
  date = new Date(),
): Promise<JSONSecurity | undefined> => {
  const [close_price, detail] = await Promise.all([
    getClosePrice(ticker_symbol, date),
    getTickerDetail(ticker_symbol),
  ]);

  if (!close_price || !detail) return;

  const { name, currency_name } = detail;

  return {
    security_id: getRandomId(),
    ticker_symbol,
    name,
    iso_currency_code: currency_name.toUpperCase(),
    close_price,
    close_price_as_of: getDateTimeString(date),
    isin: null,
    cusip: null,
    sedol: null,
    institution_security_id: null,
    institution_id: null,
    proxy_security_id: null,
    is_cash_equivalent: null,
    type: null,
    update_datetime: null,
    unofficial_currency_code: null,
    market_identifier_code: null,
    sector: null,
    industry: null,
    option_contract: null,
    fixed_income: null,
  };
};
