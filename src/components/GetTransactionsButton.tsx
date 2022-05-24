import { AccountBase, Transaction } from "plaid";
import { Dispatch, SetStateAction } from "react";

interface Props {
  setTransactions: Dispatch<SetStateAction<Transaction[][]>>;
  setAccounts: Dispatch<SetStateAction<AccountBase[][]>>;
}

const GetTransactionsButton = ({ setTransactions, setAccounts }: Props) => {
  const onClick = () => {
    fetch("/api/transactions")
      .then((r) => r.json())
      .then((r) => setTransactions(r.data));
  };
  return (
    <div className="GetTransactionsButton">
      <button onClick={onClick}>Get Transactions</button>;
    </div>
  );
};

export default GetTransactionsButton;
