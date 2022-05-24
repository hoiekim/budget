import { Transaction } from "plaid";

const TransactionsList = ({ data }: { data: Transaction[] }) => {
  const transactionRows = data.map((e, i) => {
    return (
      <tr key={i}>
        <td>{e.authorized_date}</td>
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
