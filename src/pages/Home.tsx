import { useContext } from "react";
import {
  PlaidLinkButton,
  SyncButton,
  TransactionsList,
  AccountsList,
  LoginInterface,
} from "components";
import { Context } from "lib";

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
