import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  PlaidError,
  PlaidErrorType,
  Products,
} from "plaid";
import { MaskedUser, updateItemStatus, upsertItems, logger } from "server";
import { ItemStatus, JSONItem } from "common";

const { PLAID_CLIENT_ID, PLAID_SECRET_PRODUCTION, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } =
  process.env;

export const isPlaidConfigured =
  !!PLAID_CLIENT_ID &&
  !!(PLAID_SECRET_PRODUCTION || PLAID_SECRET_DEVELOPMENT) &&
  !!PLAID_SECRET_SANDBOX;

if (!isPlaidConfigured) {
  logger.warn("Plaid is not configured. Check env vars.");
}

export const getClient = (user?: MaskedUser) => {
  if (!isPlaidConfigured) {
    throw new Error("Plaid is not configured — refusing to make Plaid API calls");
  }

  const isDemo = user?.username === "demo";
  const { production, development, sandbox } = PlaidEnvironments;

  let basePath, secret;

  if (isDemo) {
    basePath = sandbox;
    secret = PLAID_SECRET_SANDBOX;
  } else {
    if (PLAID_SECRET_PRODUCTION) {
      basePath = production;
      secret = PLAID_SECRET_PRODUCTION;
    } else {
      basePath = development;
      secret = PLAID_SECRET_DEVELOPMENT;
    }
  }

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
};

/**
 * Get a production Plaid client.
 * Used for operations that require production credentials (e.g., webhook verification).
 * Webhooks are only sent from production, so we always need production credentials.
 */
let productionClient: PlaidApi | undefined;

export const getProductionClient = () => {
  if (!isPlaidConfigured) {
    throw new Error("Plaid is not configured — refusing to make Plaid API calls");
  }
  if (productionClient) return productionClient;

  const { production } = PlaidEnvironments;

  if (!PLAID_SECRET_PRODUCTION) {
    logger.warn("Production secret not configured - webhook verification will fail", { component: "plaid" });
  }

  const config = new Configuration({
    basePath: production,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": PLAID_SECRET_PRODUCTION,
      },
    },
  });
  productionClient = new PlaidApi(config);
  return productionClient;
};

export const ignorable_error_codes = new Set(["NO_INVESTMENT_ACCOUNTS"]);

/**
 * What a Plaid sync catch block should do next, after the shared error
 * handling below has logged, recovered, and escalated as needed.
 * - `"unsupported"`: PRODUCTS_NOT_SUPPORTED — Investments was stripped from
 *   the item's available_products; the caller decides whether the item is
 *   still pushed (holdings: no; investment transactions: only if a page
 *   already succeeded).
 * - `"ignorable"`: an error code in `ignorable_error_codes` — nothing was
 *   logged and nothing escalated; the caller carries on (investment
 *   transactions keeps paging).
 * - `"failed"`: anything else, including ITEM_LOGIN_REQUIRED and transport
 *   errors with no Plaid payload — logged, escalated when it is an
 *   ItemError, and the caller pushes the item carrying the plaidError.
 */
export type PlaidSyncErrorOutcome = "unsupported" | "ignorable" | "failed";

export interface HandlePlaidSyncErrorOptions {
  user: MaskedUser;
  item: JSONItem;
  /**
   * Noun for the failure log message, e.g. `"accounts"` renders
   * `"Failed to get accounts data"`.
   */
  logLabel: string;
  /**
   * Exact info message for the PRODUCTS_NOT_SUPPORTED recovery. Only
   * callers that recover from it pass this — the per-item sync paths
   * (accounts, transactions) do not special-case the code, so for them
   * it falls through to the `"failed"` branch exactly as before.
   */
  unsupportedMessage?: string;
  /**
   * Warn instead of erroring on ITEM_LOGIN_REQUIRED. Only the per-item
   * sync paths do — the holdings/investment paths log it as an error.
   */
  warnOnLoginRequired?: boolean;
  /** Test seam: defaults are the production imports. */
  updateItemStatusFn?: typeof updateItemStatus;
  upsertItemsFn?: typeof upsertItems;
}

/**
 * Shared handling for the four Plaid sync catch blocks (see #949):
 * extracts the Plaid error payload, recovers from PRODUCTS_NOT_SUPPORTED
 * (log + strip Investments + persist), skips ignorable codes silently,
 * logs the failure, and escalates ItemErrors to BAD. The caller keeps
 * ownership of what happens next — push, break, return, or keep paging —
 * because that differs per site and is the part that must not be shared.
 * Behavior at each site is unchanged; the branching above is the union
 * of the four original blocks.
 */
export const handlePlaidSyncError = (
  error: unknown,
  {
    user,
    item,
    logLabel,
    unsupportedMessage,
    warnOnLoginRequired,
    updateItemStatusFn = updateItemStatus,
    upsertItemsFn = upsertItems,
  }: HandlePlaidSyncErrorOptions,
): { plaidError: PlaidError | undefined; outcome: PlaidSyncErrorOutcome } => {
  const errorWithResponse = error as { response?: { data?: PlaidError } };
  const plaidError = errorWithResponse?.response?.data;
  const errorCode = plaidError?.error_code;
  const { item_id } = item;

  if (errorCode === "PRODUCTS_NOT_SUPPORTED" && unsupportedMessage) {
    logger.info(unsupportedMessage, { itemId: item_id });
    const updated_products = item.available_products.filter(
      (p) => p !== Products.Investments,
    );
    upsertItemsFn(user, [{ ...item, available_products: updated_products }]).catch((e) => {
      logger.error("Failed to update available_products for item", { itemId: item_id }, e);
    });
    return { plaidError, outcome: "unsupported" };
  }

  if (errorCode && ignorable_error_codes.has(errorCode)) {
    return { plaidError, outcome: "ignorable" };
  }

  if (errorCode === "ITEM_LOGIN_REQUIRED" && warnOnLoginRequired) {
    logger.warn(`Failed to get ${logLabel} data: ITEM_LOGIN_REQUIRED`, { itemId: item_id });
  } else {
    logger.error(`Failed to get ${logLabel} data`, { itemId: item_id }, plaidError || error);
  }

  if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
    updateItemStatusFn(user, item_id, ItemStatus.BAD, plaidError.error_code).catch((e) => {
      logger.error("Failed to update item status to BAD", { itemId: item_id }, e);
    });
  }

  return { plaidError, outcome: "failed" };
};
