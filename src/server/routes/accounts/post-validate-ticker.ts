import { JSONSecurity, getRandomId, getDateTimeString } from "common";
import {
  Route,
  requireBodyObject,
  requireTickerSymbol,
  validationError,
  searchSecurities,
  upsertSecurities,
  validateTickerRateLimiter,
  polygon,
} from "server";
import { logger } from "server/lib/logger";

export interface ValidateTickerResponse {
  valid: boolean;
  security?: JSONSecurity;
  message?: string;
}

/**
 * POST /validate-ticker
 * Validates a ticker symbol against Polygon API and optionally creates/fetches
 * the security record in the local database.
 *
 * Body: { ticker_symbol: string, save?: boolean }
 * - save: if true (default), persist the security to the DB if valid
 */
export const postValidateTickerRoute = new Route<ValidateTickerResponse>(
  "POST",
  "/validate-ticker",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data as Record<string, unknown>;
    const tickerResult = requireTickerSymbol(body, "ticker_symbol");
    if (!tickerResult.success) return validationError(tickerResult.error!);
    const upperTicker = tickerResult.data!;

    // Check if we already have this security in the DB
    const existing = await searchSecurities({ ticker_symbol: upperTicker });
    if (existing.length > 0) {
      return {
        status: "success",
        body: { valid: true, security: existing[0] },
      };
    }

    // Only lookups that get past the local short-circuit can reach Polygon's
    // process-wide rate gate, which the price-refresh passes and every other
    // signed-in caller share. Those are the ones a single caller is capped on.
    if (validateTickerRateLimiter.isLimited(user.user_id)) {
      return { status: "failed", message: "Too many ticker lookups, try again in a minute." };
    }
    validateTickerRateLimiter.consume(user.user_id);

    // Validate against Polygon API
    const [detailResult, priceResult] = await Promise.all([
      polygon.getTickerDetail(upperTicker, { maxWaitMs: polygon.FOREGROUND_QUEUE_WAIT_MS }),
      polygon.getClosePrice(upperTicker, new Date(), {
        maxWaitMs: polygon.FOREGROUND_QUEUE_WAIT_MS,
      }),
    ]);

    if (!detailResult.success) {
      // A shed lookup says nothing about the symbol, so it must not come back
      // as `valid: false` — the form would label a good ticker invalid.
      if (detailResult.error === "rate_limited") {
        return { status: "failed", message: detailResult.message };
      }
      return {
        status: "success",
        body: {
          valid: false,
          message:
            detailResult.error === "no_api_key"
              ? "Market data API is not configured. Contact your administrator."
              : `Ticker "${upperTicker}" not found or invalid.`,
        },
      };
    }

    // Build security object
    const { name, currency_name } = detailResult.data;
    const close_price = priceResult.success ? priceResult.data : undefined;

    const security: JSONSecurity = {
      security_id: getRandomId(),
      ticker_symbol: upperTicker,
      name,
      iso_currency_code: currency_name.toUpperCase(),
      close_price: close_price ?? null,
      close_price_as_of: close_price != null ? getDateTimeString(new Date()) : null,
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

    try {
      const save = body.save !== false; // default true
      if (save) {
        await upsertSecurities([security]);
      }
    } catch (error: unknown) {
      logger.error("Failed to save security", { ticker: upperTicker }, error);
      // Non-fatal — still return valid result
    }

    return {
      status: "success",
      body: { valid: true, security },
    };
  },
);
