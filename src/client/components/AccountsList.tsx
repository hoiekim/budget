import { Account } from "server";
import { InstitutionTag } from "client/components";

interface Props {
  data: Account[];
}

const AccountsList = ({ data }: Props) => {
  const transactionRows = data.map((e, i) => {
    return (
      <tr key={i}>
        <td>
          <div>
            {e.balances.available} / {e.balances.current} {e.balances.iso_currency_code}
          </div>
        </td>
        <td>
          <div>{e.name}</div>
        </td>
        <td>
          <InstitutionTag institution_id={e.institution_id} />
        </td>
      </tr>
    );
  });
  return (
    <div className="AccountsList">
      <div>Accounts:</div>
      <table>
        <thead>
          <tr>
            <td>
              <div>Balance</div>
            </td>
            <td>
              <div>Name</div>
            </td>
            <td>
              <div>Institution</div>
            </td>
          </tr>
        </thead>
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default AccountsList;
