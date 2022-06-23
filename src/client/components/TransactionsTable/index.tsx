import { Transaction } from "server";
import TransactionRow from "./TransactionRow";

interface Props {
  data: Transaction[];
}

const TransactionsTable = ({ data }: Props) => {
  const transactionRows = data.map((e, i) => {
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
