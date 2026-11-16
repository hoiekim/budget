import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { MaskedUser, logger } from "server";
import { Queue } from "common";

const { PLAID_CLIENT_ID, PLAID_SECRET_PRODUCTION, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } =
  process.env;

export const isPlaidConfigured =
  !!PLAID_CLIENT_ID &&
  !!(PLAID_SECRET_PRODUCTION || PLAID_SECRET_DEVELOPMENT) &&
  !!PLAID_SECRET_SANDBOX;

if (!isPlaidConfigured) {
  logger.warn("Plaid is not configured. Check env vars.");
}

/**
 * Every call made with {@link getClient} holds a {@link plaidQueue} slot until
 * it settles, and the SDK's axios default never times out, so one stalled
 * connection would hold a shared slot forever. 30 s leaves room for a large
 * `transactionsSync` page while still handing a stuck slot back.
 */
export const PLAID_REQUEST_TIMEOUT_MS = 30_000;

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
      timeout: PLAID_REQUEST_TIMEOUT_MS,
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
};

/**
 * Every Plaid call made with {@link getClient} is metered against one
 * app-level credential shared by every user of the deployment, so their
 * concurrency is one process-wide budget. Route each client call through
 * `plaidQueue.add(() => client.someCall(...))`.
 */
export const PLAID_MAX_INFLIGHT = 8;
export const plaidQueue = new Queue({ maxInflight: PLAID_MAX_INFLIGHT });

/**
 * How long a call made while someone waits on the HTTP response may queue for
 * a {@link plaidQueue} slot. Bun reaps a silent request after 10 s, so a call
 * that cannot start inside half of that fails with `QueueWaitTimeoutError`
 * instead of being dropped with no response.
 */
export const PLAID_FOREGROUND_WAIT_MS = 5_000;

/** Test seam: the Plaid client factory. Production callers pass nothing. */
export interface PlaidClientDeps {
  getClient?: typeof getClient;
}

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
