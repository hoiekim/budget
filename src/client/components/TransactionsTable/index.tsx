import { useContext } from "react";
import { Context } from "client";
import TransactionRow from "./TransactionRow";

const TransactionsTable = () => {
  const { transactions } = useContext(Context);

  const transactionRows = Array.from(transactions.values()).map((e, i) => {
    return <TransactionRow key={i} transaction={e} />;
  });

  return (
    <div className="TransactionsTable">
      <div>Transactions:</div>
      <table>
        <thead>
          <tr>
            <td>
              <div>Date</div>
            </td>
            <td>
              <div>Name</div>
            </td>
            <td>
              <div>Amount</div>
            </td>
            <td>
              <div>Account</div>
            </td>
            <td>
              <div>Institution</div>
            </td>
            <td>
              <div>Category</div>
            </td>
          </tr>
        </thead>
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default TransactionsTable;
