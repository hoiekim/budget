import { ItemStatus } from "common";
import { Route, updateItemStatus, syncPlaidTransactions, getUserItem, upsertItems, requireBodyObject, validationError, plaid } from "server";
import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";

interface PlaidWebhookBody {
  webhook_type: "TRANSACTIONS" | "ITEM" | "HOLDINGS" | "INVESTMENTS_TRANSACTIONS";
  webhook_code: string;
  item_id: string;
  error?: { error_code: string };
}

export interface PostPlaidHookDeps {
  verifyWebhook: (rawBody: string, signedJwt?: string) => Promise<boolean>;
  syncPlaidTransactions: typeof syncPlaidTransactions;
  updateItemStatus: typeof updateItemStatus;
  getUserItem: typeof getUserItem;
  upsertItems: typeof upsertItems;
  getItem: typeof plaid.getItem;
  sendAlarm: typeof sendAlarm;
}

export const createPostPlaidHookRoute = (deps: PostPlaidHookDeps) =>
  new Route("POST", "/plaid-hook", async (req, res) => {
    // Verify webhook signature from Plaid
    const signedJwt = req.headers["plaid-verification"] as string | undefined;
    const rawBody = (req as { rawBody?: string }).rawBody;

    if (!rawBody) {
      logger.error("[Plaid Webhook] Raw body not available for verification");
      res.status(401);
      return { status: "failed", message: "Webhook verification failed" };
    }

    const isValid = await deps.verifyWebhook(rawBody, signedJwt);
    if (!isValid) {
      res.status(401);
      return { status: "failed", message: "Invalid webhook signature" };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const { webhook_type, webhook_code, item_id, error } = bodyResult.data as PlaidWebhookBody;

    const syncAndLog = async (id: string) => {
      const response = await deps.syncPlaidTransactions(id);
      if (!response) return { status: "failed" as const };
      const { added, modified, removed } = response;
      logger.info("Synced transactions via webhook", { itemId: id, added, modified, removed });
      return { status: "success" as const };
    };

    const refreshItemProducts = async (id: string) => {
      const userItem = await deps.getUserItem(id);
      if (!userItem) return { status: "failed" as const };
      const { user, item } = userItem;
      const { consented_products = [], products = [] } = await deps.getItem(item.access_token);
      const available_products = [...consented_products, ...products];
      await deps.upsertItems(user, [{ ...item, available_products }]);
      logger.info("Refreshed available_products for item", { itemId: id, available_products });
      return { status: "success" as const };
    };

    const markBadItem = async (id: string, reason: string) => {
      const response = await deps.updateItemStatus(id, ItemStatus.BAD);
      if (!response) return { status: "failed" as const };
      deps.sendAlarm("Item Bad Status", `**Item:** ${id}\n**Reason:** ${reason}`).catch(() => undefined);
      return { status: "success" as const };
    };

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

// Functions are referenced via arrow indirection so the bindings are looked
// up at call time, not at module init. Top-level access to plaid.verifyWebhook
// at init time crosses a circular import boundary (server/lib → routes →
// here) and trips ESM TDZ.
export const postPlaidHookRoute = createPostPlaidHookRoute({
  verifyWebhook: (rawBody, signedJwt) => plaid.verifyWebhook(rawBody, signedJwt),
  syncPlaidTransactions: (id) => syncPlaidTransactions(id),
  updateItemStatus: (id, status) => updateItemStatus(id, status),
  getUserItem: (id) => getUserItem(id),
  upsertItems: (user, items) => upsertItems(user, items),
  getItem: (accessToken) => plaid.getItem(accessToken),
  sendAlarm: (title, message) => sendAlarm(title, message),
});
