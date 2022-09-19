import { useMemo } from "react";
import { Account, useAppContext } from "client";
import { AccountsTable } from "client/components";

const ignorable_error_codes = new Set(["NO_INVESTMENT_ACCOUNTS"]);

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
      if (ignorable_error_codes.has(error_code)) return;
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
