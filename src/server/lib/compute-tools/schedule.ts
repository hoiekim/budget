import { ItemProvider, ONE_HOUR } from "common";
import { getAllItems } from "server";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";
import { logger } from "../logger";

export const scheduledSync = async () => {
  logger.info("Scheduled sync started");
  try {
    const items = await getAllItems();
    for (const { item_id, provider } of items) {
      if (provider === ItemProvider.PLAID) {
        let accountsCount = 0;
        let transactionsCount = 0;

        await syncPlaidAccounts(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidAccounts");
            const { accounts, investmentAccounts } = r;
            accountsCount += (accounts?.length || 0) + (investmentAccounts?.length || 0);
          })
          .catch((error) => logger.error("Sync Plaid accounts failed", { itemId: item_id }, error));

        await syncPlaidTransactions(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidTransactions");
            const { added, modified, removed } = r;
            transactionsCount += added + modified + removed;
          })
          .catch((error) => logger.error("Sync Plaid transactions failed", { itemId: item_id }, error));

        logger.info("Synced Plaid item", {
          itemId: item_id,
          accountsUpdated: accountsCount,
          transactionsUpdated: transactionsCount,
        });
      } else if (provider === ItemProvider.SIMPLE_FIN) {
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
          .catch((error) => logger.error("Sync SimpleFin data failed", { itemId: item_id }, error));
      }
    }
  } catch (err) {
    logger.error("Error occurred during scheduled sync", {}, err);
  } finally {
    logger.info("Scheduled sync completed");
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
