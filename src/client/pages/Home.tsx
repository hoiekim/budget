import { useContext } from "react";
import { Context } from "client";
import {
  LoginInterface,
  PlaidLinkButton,
  SyncButton,
  TransactionsTable,
  AccountsList,
} from "client/components";

const Home = () => {
  const { accounts, transactions } = useContext(Context);
  return (
    <div className="Home">
      <LoginInterface />
      <PlaidLinkButton />
      <SyncButton />
      <AccountsList data={Array.from(accounts.values())} />
      <TransactionsTable data={Array.from(transactions.values())} />
    </div>
  );
};

export default Home;
