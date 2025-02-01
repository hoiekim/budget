import { ItemProvider, ONE_HOUR } from "common";
import { searchItems } from "server";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";

export const scheduledSync = async () => {
  try {
    const items = await searchItems();
    const promises = items.flatMap(({ item_id, provider }) => {
      if (provider === ItemProvider.PLAID) {
        const accountsPromise = syncPlaidAccounts(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidAccounts");
            const { accounts, investmentAccounts } = r;
            const numberOfAccounts = accounts?.length || 0;
            const numberOfInvestmentAccounts = investmentAccounts?.length || 0;
            console.group(`Synced accounts for Plaid item: ${item_id}`);
            console.log(`${numberOfAccounts} accounts`);
            console.log(`${numberOfInvestmentAccounts} investmentAccounts`);
            console.groupEnd();
          })
          .catch(console.error);

        const transactionsPromise = syncPlaidTransactions(item_id)
          .then((r) => {
            if (!r) throw new Error("Error occured during syncAllPlaidTransactions");
            const { added, modified, removed } = r;
            console.group(`Synced transactions for Plaid item: ${item_id}`);
            console.log(`${added} added`);
            console.log(`${modified} modified`);
            console.log(`${removed} removed`);
            console.groupEnd();
          })
          .catch(console.error);

        return [accountsPromise, transactionsPromise];
      } else if (provider === ItemProvider.SIMPLE_FIN) {
        const promise = syncSimpleFinData(item_id).then((r) => {
          if (!r) throw new Error("Error occured during syncAllSimpleFinData");
          const { accounts, transactions, investmentTransactions } = r;
          const numberOfAccounts = accounts?.length || 0;
          console.group(`Synced all data for SimpleFin item: ${item_id}`);
          console.log(`${numberOfAccounts} accounts`);
          console.log(`${transactions.length} transactions updated`);
          console.log(`${investmentTransactions.length} investmentTransactions updated`);
          console.groupEnd();
        });

        return [promise];
      }
    });
    await Promise.all(promises);
    console.log("Scheduled sync completed");
  } catch (err) {
    console.error("Error occured during scheduled sync");
    console.error(err);
  } finally {
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
