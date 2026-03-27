import { ItemProvider, ONE_HOUR } from "common";
import { getAllItems, logger, updateItemSyncStatus } from "server";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";

let isSyncing = false;

export const scheduledSync = async () => {
  if (isSyncing) {
    logger.warn("Skipping scheduled sync — previous sync still running");
    setTimeout(scheduledSync, ONE_HOUR);
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
  } finally {
    isSyncing = false;
    logger.info("Scheduled sync completed");
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
