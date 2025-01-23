import { ItemStatus } from "common";
import { Route, updateItemStatus, syncAllTransactions } from "server";

interface PlaidWebhookBody {
  webhook_type: "TRANSACTIONS" | "ITEM";
  webhook_code: string;
  item_id: string;
  error: { error_code: string };
}

// TODO: verify request sender is plaid
export const postPlaidHookRoute = new Route("POST", "/plaid-hook", async (req) => {
  const { webhook_type, webhook_code, item_id, error } = req.body as PlaidWebhookBody;
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
      return await markBadItem(item_id);
    } else if (webhook_code === "ERROR") {
      const { error_code } = error;
      if (error_code === "ITEM_LOGIN_REQUIRED") {
        return await markBadItem(item_id);
      }
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

  console.log(`Unhandled hook called for item ${item_id}`);
  console.log("Request body:", req.body);
});

const syncAndLog = async (item_id: string) => {
  const response = await syncAllTransactions(item_id);
  if (!response) return { status: "failed" as const };
  const { added, modified, removed } = response;
  console.group(`Synced transactions for item: ${item_id}`);
  console.log(`${added} added, ${modified} modified, ${removed} removed`);
  console.groupEnd();
  return { status: "success" as const };
};

const markBadItem = async (item_id: string) => {
  const response = await updateItemStatus(item_id, ItemStatus.BAD);
  if (!response) return { status: "failed" as const };
  return { status: "success" as const };
};
