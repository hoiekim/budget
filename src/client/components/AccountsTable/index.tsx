import { useContext } from "react";
import { Context } from "client";
import AccountRow from "./AccountRow";

const AccountsTable = () => {
  const { accounts } = useContext(Context);

  const transactionRows = Array.from(accounts.values()).map((e, i) => {
    return <AccountRow key={i} account={e} />;
  });

  return (
    <div className="AccountsTable">
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

export default AccountsTable;
