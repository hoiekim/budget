import { useMemo } from "react";
import { AccountType } from "plaid";
import { useAppContext } from "client";
import { AccountsTable } from "client/components";
import { Account } from "server";

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
    items.forEach((e) => {
      if (!e.plaidError) return;
      const errorAccount = {
        item_id: e.item_id,
        institution_id: e.institution_id,
        custom_name: "Unknown",
        hide: false,
        label: {},
        account_id: "",
        balances: {
          available: 0,
          current: 0,
          limit: 0,
          iso_currency_code: "USD",
          unofficial_currency_code: "USD",
        },
        mask: "",
        name: "Unknown",
        official_name: "Unknown",
        type: AccountType.Other,
        subtype: null,
      };
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
