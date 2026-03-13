import { JSONSecurity, getRandomId, getDateTimeString } from "common";
import { Route, requireBodyObject, validationError, searchSecurities, upsertSecurities, polygon } from "server";
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
    const ticker_symbol = body.ticker_symbol as string | undefined;

    if (!ticker_symbol || typeof ticker_symbol !== "string") {
      return validationError("ticker_symbol is required");
    }

    const upperTicker = ticker_symbol.trim().toUpperCase();

    // Check if we already have this security in the DB
    const existing = await searchSecurities({ ticker_symbol: upperTicker });
    if (existing.length > 0) {
      return {
        status: "success",
        body: { valid: true, security: existing[0] },
      };
    }

    // Validate against Polygon API
    const [detailResult, priceResult] = await Promise.all([
      polygon.getTickerDetail(upperTicker),
      polygon.getClosePrice(upperTicker, new Date()),
    ]);

    if (!detailResult.success) {
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
