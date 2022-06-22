import { useContext } from "react";
import { Context } from "client";
import {
  LoginInterface,
  PlaidLinkButton,
  SyncButton,
  TransactionsList,
  AccountsList,
} from "client/components";

const Home = () => {
  const { accounts, transactions } = useContext(Context);
  return (
    <div className="Home">
      <LoginInterface />
      <PlaidLinkButton />
      <SyncButton />
      <AccountsList data={accounts} />
      <TransactionsList data={transactions} />
    </div>
  );
};

export default Home;
