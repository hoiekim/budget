import { useContext } from "react";
import { Transaction } from "server";
import { Context } from "client";
import { InstitutionTag } from "client/components";

interface Props {
  data: Transaction[];
}

const TransactionsList = ({ data }: Props) => {
  const { accounts } = useContext(Context);

  const transactionRows = data.map((e, i) => {
    const institution_id = accounts.get(e.account_id)?.institution_id;

    return (
      <tr key={i}>
        <td>{e.authorized_date || e.date}</td>
        <td>{e.name}</td>
        <td>{e.amount}</td>
        <td>
          <InstitutionTag institution_id={institution_id} />
        </td>
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
