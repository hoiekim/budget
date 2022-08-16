import { useMemo } from "react";
import { useAppContext } from "client";
import {
  Header,
  TransactionsTable,
  AccountsTable,
  BudgetsTable,
} from "client/components";

const Home = () => {
  const { user, transactions, accounts } = useAppContext();

  const accountsArray = useMemo(() => {
    return Array.from(accounts.values()).filter((e) => !e.hide);
  }, [accounts]);

  const errorAccountsArray = useMemo(() => {
    if (!user) return [];
    const filteredItems = user.items.filter((e) => {
      return e.plaidError && !accountsArray.find((f) => f.item_id === e.item_id);
    });
    return filteredItems.map((e) => ({
      item_id: e.item_id,
      institution_id: e.institution_id,
    }));
  }, [user, accountsArray]);

  const transactionsArray = useMemo(() => {
    return Array.from(transactions.values())
      .filter((e) => !accounts.get(e.account_id)?.hide)
      .sort((a, b) => {
        return a.transaction_id > b.transaction_id ? 1 : -1;
      });
  }, [transactions, accounts]);

  return (
    <div className="Home">
      <Header />
      <div className="row-spacer" />
      <BudgetsTable />
      <div className="row-spacer" />
      <AccountsTable
        accountsArray={accountsArray}
        errorAccountsArray={errorAccountsArray}
      />
      <div className="row-spacer" />
      <TransactionsTable transactionsArray={transactionsArray} />
    </div>
  );
};

export default Home;
