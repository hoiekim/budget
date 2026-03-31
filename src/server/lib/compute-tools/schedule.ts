import { ItemProvider, ONE_HOUR } from "common";
import { getAllItems, logger, updateItemSyncStatus } from "server";
import { sendAlarm } from "server/lib/alarm";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";

let syncTimer: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

const runSync = async () => {
  if (isSyncing) {
    logger.warn("Skipping scheduled sync — previous sync still running");
    return;
  }
  isSyncing = true;
  logger.info("Scheduled sync started");
  try {
    const items = await getAllItems();
    for (const { item_id, provider } of items) {
      if (provider === ItemProvider.PLAID) {
        let accountsCount = 0;
        let transactionsCount = 0;
        let syncError: string | undefined;

        await syncPlaidAccounts(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidAccounts");
            const { accounts, investmentAccounts } = r;
            accountsCount += (accounts?.length || 0) + (investmentAccounts?.length || 0);
          })
          .catch((error) => {
            logger.error("Sync Plaid accounts failed", { itemId: item_id }, error);
            sendAlarm("Scheduled Sync Error: Plaid accounts failed", `**Item:** ${item_id}\n**Error:** ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
            syncError = error instanceof Error ? error.message : String(error);
          });

        if (!syncError) {
          await syncPlaidTransactions(item_id)
            .then((r) => {
              if (!r) throw new Error("Error occured during syncAllPlaidTransactions");
              const { added, modified, removed } = r;
              transactionsCount += added + modified + removed;
            })
            .catch((error) => {
              logger.error("Sync Plaid transactions failed", { itemId: item_id }, error);
              sendAlarm("Scheduled Sync Error: Plaid transactions failed", `**Item:** ${item_id}\n**Error:** ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
              syncError = error instanceof Error ? error.message : String(error);
            });
        }

        await updateItemSyncStatus(item_id, {
          success: !syncError,
          error: syncError,
        });

        logger.info("Synced Plaid item", {
          itemId: item_id,
          accountsUpdated: accountsCount,
          transactionsUpdated: transactionsCount,
          syncError,
        });
      } else if (provider === ItemProvider.SIMPLE_FIN) {
        let syncError: string | undefined;

        await syncSimpleFinData(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllSimpleFinData");
            const { accounts, transactions, investmentTransactions } = r;
            const transactionsCount = transactions.length + investmentTransactions.length;
            logger.info("Synced SimpleFin item", {
              itemId: item_id,
              accountsUpdated: accounts?.length || 0,
              transactionsUpdated: transactionsCount,
            });
          })
          .catch((error) => {
            logger.error("Sync SimpleFin data failed", { itemId: item_id }, error);
            sendAlarm("Scheduled Sync Error: SimpleFin data failed", `**Item:** ${item_id}\n**Error:** ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
            syncError = error instanceof Error ? error.message : String(error);
          });

        await updateItemSyncStatus(item_id, {
          success: !syncError,
          error: syncError,
        });
      }
    }
  } catch (err) {
    logger.error("Error occurred during scheduled sync", {}, err);
    sendAlarm("Scheduled Sync Failed", `**Error:** ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
  } finally {
    isSyncing = false;
    logger.info("Scheduled sync completed");
  }
};

/** Start the hourly sync interval. Runs once immediately, then every hour. */
export const scheduledSync = () => {
  runSync();
  syncTimer = setInterval(runSync, ONE_HOUR);
  syncTimer.unref();
};

/** Cancel the scheduled sync interval. Call during graceful shutdown. */
export const stopScheduledSync = () => {
  if (syncTimer !== null) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
};
