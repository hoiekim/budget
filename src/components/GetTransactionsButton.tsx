import { useContext } from "react";
import { call } from "lib";
import { Context } from "App";

const GetTransactionsButton = () => {
  const { setTransactions, setAccounts } = useContext(Context);
  const onClick = () => {
    call("/api/transactions", { noCache: true }).then((r) =>
      setTransactions(r.data || [])
    );
    call("/api/accounts", { noCache: true }).then((r) =>
      setAccounts(r.data || [])
    );
  };
  return (
    <div className="GetTransactionsButton">
      <button onClick={onClick}>Get Transactions</button>
    </div>
  );
};

export default GetTransactionsButton;
