import { AccountBase } from "plaid";

interface Props {
  data: AccountBase[];
}

const AccountsList = ({ data }: Props) => {
  const transactionRows = data.map((e, i) => {
    return (
      <tr key={i}>
        <td>
          {e.balances.available} / {e.balances.current}
        </td>
        <td>{e.balances.iso_currency_code}</td>
        <td>{e.name}</td>
      </tr>
    );
  });
  return (
    <table className="AccountsList">
      <thead>
        <tr>
          <td>Accounts:</td>
        </tr>
      </thead>
      <tbody>{transactionRows}</tbody>
    </table>
  );
};

export default AccountsList;
