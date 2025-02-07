/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString, getDateTimeString, Security } from "common";

const POLYGON_HOST = "https://api.polygon.io";
const { POLYGON_API_KEY } = process.env;

export const getClosePrice = async (ticker_symbol: string, date: Date) => {
  const dateString = getDateString(date);
  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${ticker_symbol}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/v2/aggs/${tickerParameter}/${rangeParameter}?apiKey=${POLYGON_API_KEY}`;
  const { results } = await fetch(path).then((r) => r.json());
  if (!results) return undefined;
  // c = close price
  return results[0].c as number;
};

export const getTickerDetail = async (ticker_symbol: string) => {
  const path = `${POLYGON_HOST}/v3/reference/tickers/${ticker_symbol}?apiKey=${POLYGON_API_KEY}`;
  const { results } = await fetch(path).then((r) => r.json());
  if (!results) return undefined;
  const name = results.name as string;
  const currency_name = results.currency_name as string;
  return { ticker_symbol, name, currency_name };
};

export const getSecurityForSymbol = async (ticker_symbol: string, date = new Date()) => {
  const [close_price, detail] = await Promise.all([
    getClosePrice(ticker_symbol, date),
    getTickerDetail(ticker_symbol),
  ]);

  if (!close_price || !detail) return;

  const { name, currency_name } = detail;

  return new Security({
    ticker_symbol,
    name,
    iso_currency_code: currency_name.toUpperCase(),
    close_price,
    close_price_as_of: getDateTimeString(date),
  });
};
