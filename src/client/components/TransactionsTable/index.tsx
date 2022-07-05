import { Transaction } from "server";
import { useAppContext, useLocalStorage, useSorter } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";
import "./index.css";

export type Visibles = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

export type TransactionHeaders = Transaction & { account?: never; institution?: never };

const TransactionsTable = () => {
  const { transactions, accounts, institutions } = useAppContext();
  const [visibles, setVisibles] = useLocalStorage<Visibles>("visibles", {});

  const { sort, setSortBy, getArrow } = useSorter<TransactionHeaders>("transactions", [
    ["authorized_date", "descending"],
  ]);

  const transactionsArray = sort(Array.from(transactions.values()), (e, key) => {
    if (key === "authorized_date") {
      return new Date(e.authorized_date || e.date);
    } else if (key === "merchant_name") {
      return e.merchant_name || e.name;
    } else if (key === "account") {
      return accounts.get(e.account_id)?.name;
    } else if (key === "institution") {
      const account = accounts.get(e.account_id);
      return institutions.get(account?.institution_id || "")?.name;
    } else if (key === "category") {
      return e.category && e.category[0];
    } else {
      return e[key];
    }
  });

  const transactionRows = transactionsArray.map((e, i) => {
    return <TransactionRow key={i} transaction={e} />;
  });

  return (
    <div className="TransactionsTable">
      <div>Transactions:</div>
      <table>
        <TransactionsHead setSortBy={setSortBy} getArrow={getArrow} />
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default TransactionsTable;
