import { useMemo } from "react";
import { useAppContext } from "client";
import { AccountsDonut, AccountsTable } from "client/components";
import { Account } from "common";
import "./index.css";

export const AccountsPage = () => {
  const { user, data } = useAppContext();
  const { items, accounts } = data;

  const accountsArray = useMemo(() => {
    return accounts
      .filter((e) => !e.hide)
      .sort((a, b) => {
        if (a.id < b.id) return 1;
        if (a.id > b.id) return -1;
        return 0;
      });
  }, [accounts]);

  const errorAccountsArray = useMemo((): Account[] => {
    if (!user) return [];
    const result: Account[] = [];
    items.forEach(({ item_id, institution_id, plaidError }) => {
      if (!plaidError) return;
      let accountExists = false;
      accounts.forEach((account) => {
        if (account.item_id === item_id) accountExists = true;
      });
      if (accountExists) return;
      const errorAccount = new Account({ item_id, institution_id: institution_id || "unknown" });
      result.push(errorAccount);
    });

    return result;
  }, [user, items, accounts]);

  return (
    <div className="AccountsPage">
      <h2>All Accounts</h2>
      <AccountsDonut />
      <AccountsTable accountsArray={[...accountsArray, ...errorAccountsArray]} />
    </div>
  );
};
