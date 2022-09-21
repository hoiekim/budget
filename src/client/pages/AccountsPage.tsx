import { useMemo } from "react";
import { Account, useAppContext } from "client";
import { AccountsTable } from "client/components";

const AccountsPage = () => {
  const { user, items, accounts } = useAppContext();

  const accountsArray = useMemo(() => {
    const array: Account[] = [];
    accounts.forEach((e) => !e.hide && array.push(e));
    return array;
  }, [accounts]);

  const errorAccountsArray = useMemo((): Account[] => {
    if (!user) return [];
    const result: Account[] = [];
    items.forEach(({ item_id, institution_id, plaidError }) => {
      if (!plaidError) return;
      const { error_code } = plaidError;
      const errorAccount = new Account({ item_id, institution_id });
      result.push(errorAccount);
    });

    return result;
  }, [user, items]);

  return (
    <div className="AccountsPage">
      <AccountsTable accountsArray={[...accountsArray, ...errorAccountsArray]} />
    </div>
  );
};

export default AccountsPage;
