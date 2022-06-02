import { useContext, useRef, useEffect } from "react";
import { Transaction, AccountBase } from "plaid";
import { read } from "lib";
import { Context, Cache } from "App";

const GetTransactionsButton = () => {
  const { setTransactions, setAccounts } = useContext(Context);
  const setTransactionsRef = useRef(setTransactions);
  const setAccountsRef = useRef(setAccounts);

  useEffect(() => {
    setTransactionsRef.current = setTransactions;
  }, [setTransactions]);

  useEffect(() => {
    setAccountsRef.current = setAccounts;
  }, [setAccounts]);

  const onClick = () => {
    read<Transaction[]>("/api/transactions-stream", (r) => {
      r.data?.forEach((e) => Cache.transactions.set(e.transaction_id, e));
      const array = Array.from(Cache.transactions.values());
      setTransactionsRef.current(array);
    });
    read<AccountBase[]>("/api/accounts-stream", (r) => {
      r.data?.forEach((e) => Cache.accounts.set(e.account_id, e));
      const array = Array.from(Cache.accounts.values());
      setAccountsRef.current(array);
    });
  };

  return (
    <div className="GetTransactionsButton">
      <button onClick={onClick}>Get Transactions</button>
    </div>
  );
};

export default GetTransactionsButton;
