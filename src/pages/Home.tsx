import { useContext } from "react";
import {
  Link,
  GetTransactionsButton,
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
      <Link />
      <GetTransactionsButton />
      <AccountsList data={accounts} />
      <TransactionsList data={transactions} />
    </div>
  );
};

export default Home;
