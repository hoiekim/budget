import { Route, requireQueryString, requireTickerSymbol, validationError, getRestatementCloses } from "server";
import { isCalendarDate } from "common";
import type { RestatementCloses } from "common";


/**
 * GET /daily-closes?ticker=&from=YYYY-MM-DD&to=YYYY-MM-DD
 * A public fund's daily closes, as traded and dividend-adjusted, for pricing
 * the rows of a plan statement the user marked as restated from a trust.
 */
export const getDailyClosesRoute = new Route<RestatementCloses>("GET", "/daily-closes", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };

  const tickerParam = requireQueryString(req, "ticker");
  if (!tickerParam.success) return validationError(tickerParam.error!);
  const ticker = requireTickerSymbol({ ticker: tickerParam.data! }, "ticker");
  if (!ticker.success) return validationError(ticker.error!);

  const range: string[] = [];
  for (const param of ["from", "to"]) {
    const value = requireQueryString(req, param);
    if (!value.success) return validationError(value.error!);
    if (!isCalendarDate(value.data!)) return validationError(`${param} must be a YYYY-MM-DD date`);
    range.push(value.data!);
  }
  const [from, to] = range;
  if (from > to) return validationError("from must not be after to");

  return { status: "success", body: await getRestatementCloses(user, ticker.data!, from, to) };
});
