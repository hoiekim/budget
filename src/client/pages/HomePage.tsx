import { useMemo } from "react";
import { AccountType } from "plaid";
import { IsNow, useAppContext } from "client";
import { TransactionsTable, AccountsTable, BudgetsTable } from "client/components";
import { Account, Transaction } from "server";

const Home = () => {
  const { user, items, transactions, accounts, selectedInterval } = useAppContext();

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

  const transactionsArray = useMemo(() => {
    const array: Transaction[] = [];
    const isNow = new IsNow();
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = isNow.within(selectedInterval).from(transactionDate);
      if (!hidden && within) array.push(e);
    });
    return array;
  }, [transactions, accounts, selectedInterval]);

  return (
    <div className="Home">
      <BudgetsTable />
      <AccountsTable accountsArray={[...accountsArray, ...errorAccountsArray]} />
      <TransactionsTable transactionsArray={transactionsArray} />
    </div>
  );
};

export default Home;
