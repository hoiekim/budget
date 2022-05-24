import { AccountBase, Transaction } from "plaid";
import { useState } from "react";
import {
  Link,
  GetTransactionsButton,
  TransactionsList,
  AccountsList,
} from "components";

const Home = () => {
  const [transactions, setTransactions] = useState<Transaction[][]>([]);
  const [accounts, setAccounts] = useState<AccountBase[][]>([]);
  return (
    <div className="Home">
      <Link />
      <GetTransactionsButton
        setTransactions={setTransactions}
        setAccounts={setAccounts}
      />
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
