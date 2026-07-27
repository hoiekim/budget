import { ItemStatus, TableName } from "common";
import { Route, updateItemStatus, syncPlaidTransactions, getUserItem, upsertItems, requireBodyObject, validationError, plaid, emitToUser } from "server";
import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";

interface PlaidWebhookBody {
  webhook_type: "TRANSACTIONS" | "ITEM" | "HOLDINGS" | "INVESTMENTS_TRANSACTIONS";
  webhook_code: string;
  item_id: string;
  error?: { error_code: string };
}

export const postPlaidHookRoute = new Route("POST", "/plaid-hook", async (req, res) => {
  // Verify webhook signature from Plaid
  const signedJwt = req.headers["plaid-verification"] as string | undefined;
  const rawBody = (req as { rawBody?: string }).rawBody;

  if (!rawBody) {
    logger.error("[Plaid Webhook] Raw body not available for verification");
    res.status(401);
    return { status: "failed", message: "Webhook verification failed" };
  }

  const isValid = await plaid.verifyWebhook(rawBody, signedJwt);
  if (!isValid) {
    res.status(401);
    return { status: "failed", message: "Invalid webhook signature" };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const { webhook_type, webhook_code, item_id, error } = bodyResult.data as PlaidWebhookBody;
  if (webhook_type === "TRANSACTIONS") {
    if (webhook_code === "SYNC_UPDATES_AVAILABLE") {
      return await syncAndLog(item_id);
    } else if (
      ["DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "TRANSACTIONS_REMOVED"].includes(
        webhook_code
      )
    ) {
      return { status: "success" };
    }
  } else if (webhook_type === "ITEM") {
    if (webhook_code === "WEBHOOK_UPDATE_ACKNOWLEDGED") {
      return { status: "success" };
    } else if (webhook_code === "PENDING_EXPIRATION") {
      return await markBadItem(item_id, "PENDING_EXPIRATION");
    } else if (webhook_code === "ERROR") {
      const error_code = error?.error_code;
      if (error_code === "ITEM_LOGIN_REQUIRED") {
        return await markBadItem(item_id, "ITEM_LOGIN_REQUIRED");
      }
    } else if (webhook_code === "USER_ACCOUNT_REVOKED" || webhook_code === "ITEM_UPDATED") {
      return await refreshItemProducts(item_id);
    }
  } else if (webhook_type === "HOLDINGS") {
    if (webhook_code === "DEFAULT_UPDATE") {
      return await syncAndLog(item_id);
    }
  } else if (webhook_type === "INVESTMENTS_TRANSACTIONS") {
    if (["DEFAULT_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)) {
      return await syncAndLog(item_id);
    }
  }

  logger.warn("Unhandled webhook", { itemId: item_id, webhookType: webhook_type, webhookCode: webhook_code, body: req.body });
});

// Real-time collaboration (#656): a Plaid webhook lands out-of-band from any
// user tab, so mutations here don't ride the normal per-user-request emit
// path in start.ts. Resolve the item's owner from `item_id` and fan the
// resulting `<table>-updated` events out to that user's open tabs so the UI
// picks up the auto-imported data without a page reload.
const emitToItemOwner = async (item_id: string, domains: TableName[]) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) {
    logger.warn("Plaid webhook emit skipped — no user for item", { itemId: item_id });
    return;
  }
  for (const domain of domains) emitToUser(userItem.user.user_id, domain);
};

const syncAndLog = async (item_id: string) => {
  const response = await syncPlaidTransactions(item_id);
  if (!response) return { status: "failed" as const };
  const { user_id, added, modified, removed } = response;
  logger.info("Synced transactions via webhook", { itemId: item_id, added, modified, removed });
  if (added || modified || removed) {
    // syncPlaidTransactions writes to both transactions and investment_transactions
    // (parallel branches). Emit only `transactions` — the client's syncDomain
    // case body handles both series in a single /api/transactions fetch, so
    // emitting `investment_transactions` too would double the client refetch
    // (different debounce keys don't collapse into one call).
    emitToUser(user_id, TableName.Transactions);
  }
  return { status: "success" as const };
};

const refreshItemProducts = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return { status: "failed" as const };
  const { user, item } = userItem;
  const { consented_products = [], products = [] } = await plaid.getItem(item.access_token);
  const available_products = [...consented_products, ...products];
  await upsertItems(user, [{ ...item, available_products }]);
  logger.info("Refreshed available_products for item", { itemId: item_id, available_products });
  emitToUser(user.user_id, TableName.Accounts);
  return { status: "success" as const };
};

const markBadItem = async (item_id: string, reason: string) => {
  const response = await updateItemStatus(item_id, ItemStatus.BAD);
  if (!response) return { status: "failed" as const };
  sendAlarm("Item Bad Status", `**Item:** ${item_id}\n**Reason:** ${reason}`).catch(() => undefined);
  await emitToItemOwner(item_id, [TableName.Accounts]);
  return { status: "success" as const };
};
