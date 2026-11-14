import { RestatementCloses } from "common";
import {
  MaskedUser,
  getDailyCloses,
  peekDailyCloses,
  warmDailyCloses,
  polygon,
  polygonLookupRateLimiter,
  POLYGON_LOOKUP_SHED_MESSAGE,
} from "server";

/**
 * The daily closes a restated fund's rows are priced and checked against. A
 * call that would reach the shared market data gate is charged to the same
 * per-user budget the ticker lookups use. It waits only as long as any other
 * request a person is watching; past that the fetch carries on in the
 * background and the answer is "still loading", for the page to retry.
 */
export const getRestatementCloses = async (
  user: MaskedUser,
  ticker: string,
  from: string,
  to: string,
): Promise<RestatementCloses> => {
  const stillLoading = { message: `Prices for ${ticker} are still loading. Retry in a minute.`, retryable: true };

  const peek = peekDailyCloses(ticker, from, to);
  if (peek === "loading") return stillLoading;
  if (peek) return peek.success ? { bars: peek.data } : { message: peek.message };

  if (polygonLookupRateLimiter.isLimited(user.user_id)) return { message: POLYGON_LOOKUP_SHED_MESSAGE };
  polygonLookupRateLimiter.consume(user.user_id);
  const result = await getDailyCloses(ticker, from, to, { maxWaitMs: polygon.FOREGROUND_QUEUE_WAIT_MS });
  if (result.success) return { bars: result.data };
  if (result.error === "rate_limited") {
    warmDailyCloses(ticker, from);
    return stillLoading;
  }
  return { message: result.message };
};
