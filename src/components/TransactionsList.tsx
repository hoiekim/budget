import { Transaction } from "plaid";

interface Props {
  data: Transaction[];
}

const TransactionsList = ({ data }: Props) => {
  const transactionRows = data.map((e, i) => {
    return (
      <tr key={i}>
        <td>{e.authorized_date || e.date}</td>
        <td>{e.name}</td>
        <td>{e.amount}</td>
      </tr>
    );
  });
  return (
    <table className="TransactionsList">
      <thead>
        <tr>
          <td>Transactions:</td>
        </tr>
      </thead>
      <tbody>{transactionRows}</tbody>
    </table>
  );
};

export default TransactionsList;
