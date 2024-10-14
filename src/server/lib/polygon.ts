/**
 * We use polygon API to get stock price data, etc.
 * https://polygon.io/docs/stocks/getting-started
 */

import { getDateString } from "common";

const POLYGON_HOST = "https://api.polygon.io/v2";
const { POLYGON_API_KEY } = process.env;

export const getClosePrice = async (ticker_symbol: string, date: Date) => {
  const dateString = getDateString(date);
  const from = dateString;
  const to = dateString;
  const tickerParameter = `ticker/${ticker_symbol}`;
  const rangeParameter = `range/1/day/${from}/${to}`;
  const path = `${POLYGON_HOST}/aggs/${tickerParameter}/${rangeParameter}?apiKey=${POLYGON_API_KEY}`;
  const { results } = await fetch(path).then((r) => r.json());
  if (!results) return undefined;
  // c = close price
  return results[0].c as number;
};
