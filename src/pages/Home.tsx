import { useContext } from "react";
import {
  Link,
  GetTransactionsButton,
  TransactionsList,
  AccountsList,
  LoginInterface,
} from "components";
import { Context } from "App";

export interface User {
  id: string;
  username: string;
}

const Home = () => {
  const { accounts, transactions } = useContext(Context);
  return (
    <div className="Home">
      <LoginInterface />
      <Link />
      <GetTransactionsButton />
      {accounts.map((e, i) => (
        <AccountsList key={i} data={e} />
      ))}
      {transactions.map((e, i) => (
        <TransactionsList key={i} data={e} />
      ))}
    </div>
  );
};

export default Home;
