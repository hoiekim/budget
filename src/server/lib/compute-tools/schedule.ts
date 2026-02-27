import { ItemProvider, ONE_HOUR } from "common";
import { getAllItems, updateItemSyncStatus } from "server";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";

export const scheduledSync = async () => {
  console.log(`Scheduled sync started`);
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
          .catch((err) => {
            console.error(err);
            syncError = err instanceof Error ? err.message : String(err);
          });

        if (!syncError) {
          await syncPlaidTransactions(item_id)
            .then((r) => {
              if (!r) throw new Error("Error occured during syncAllPlaidTransactions");
              const { added, modified, removed } = r;
              transactionsCount += added + modified + removed;
            })
            .catch((err) => {
              console.error(err);
              syncError = err instanceof Error ? err.message : String(err);
            });
        }

        await updateItemSyncStatus(item_id, {
          success: !syncError,
          error: syncError,
        });

        console.group(`Synced all data for Plaid item: ${item_id}`);
        console.log(`${accountsCount} accounts updated`);
        console.log(`${transactionsCount} transactions updated`);
        if (syncError) console.log(`Sync error: ${syncError}`);
        console.groupEnd();
      } else if (provider === ItemProvider.SIMPLE_FIN) {
        let syncError: string | undefined;

        await syncSimpleFinData(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllSimpleFinData");
            const { accounts, transactions, investmentTransactions } = r;
            console.group(`Synced all data for SimpleFin item: ${item_id}`);
            console.log(`${accounts?.length || 0} accounts updated`);
            const transactionsCount = transactions.length + investmentTransactions.length;
            console.log(`${transactionsCount} transactions updated`);
            console.groupEnd();
          })
          .catch((err) => {
            console.error(err);
            syncError = err instanceof Error ? err.message : String(err);
          });

        await updateItemSyncStatus(item_id, {
          success: !syncError,
          error: syncError,
        });
      }
    }
  } catch (err) {
    console.error("Error occured during scheduled sync");
    console.error(err);
  } finally {
    console.log("Scheduled sync completed");
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
