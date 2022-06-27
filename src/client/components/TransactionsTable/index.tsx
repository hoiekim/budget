import { useAppContext } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";

const TransactionsTable = () => {
  const { transactions } = useAppContext();

  const transactionRows = Array.from(transactions.values()).map((e, i) => {
    return <TransactionRow key={i} transaction={e} />;
  });

  return (
    <div className="TransactionsTable">
      <div>Transactions:</div>
      <table>
        <TransactionsHead />
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default TransactionsTable;
