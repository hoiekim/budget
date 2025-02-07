import { ItemProvider, ONE_HOUR } from "common";
import { searchItems } from "server";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";

export const scheduledSync = async () => {
  console.log(`Scheduled sync started`);
  try {
    const items = await searchItems();
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
          .catch(console.error);

        await syncPlaidTransactions(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidTransactions");
            const { added, modified, removed } = r;
            transactionsCount += added + modified + removed;
          })
          .catch(console.error);

        console.group(`Synced all data for Plaid item: ${item_id}`);
        console.log(`${accountsCount} accounts updated`);
        console.log(`${transactionsCount} transactions updated`);
        console.groupEnd();
      } else if (provider === ItemProvider.SIMPLE_FIN) {
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
          .catch(console.error);
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
