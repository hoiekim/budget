import { Account } from "server";
import { Sorter } from "client";
import { AccountHeaders } from ".";

interface Props {
  sorter: Sorter<Account, AccountHeaders>;
  getHeader: (key: keyof AccountHeaders) => string;
}

const AccountsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;
  return (
    <thead>
      <tr>
        {getVisible("balances") && (
          <td>
            <div>
              <button onClick={() => setSortBy("balances")}>
                {getHeader("balances")} {getArrow("balances")}
              </button>
              <button onClick={() => toggleVisible("balances")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("name") && (
          <td>
            <div>
              <button onClick={() => setSortBy("name")}>
                {getHeader("name")} {getArrow("name")}
              </button>
              <button onClick={() => toggleVisible("name")}>✕</button>
            </div>
          </td>
        )}
        <td>
          <div>Official Name</div>
        </td>
        {getVisible("institution") && (
          <td>
            <div>
              <button onClick={() => setSortBy("institution")}>
                {getHeader("institution")} {getArrow("institution")}
              </button>
              <button onClick={() => toggleVisible("institution")}>✕</button>
            </div>
          </td>
        )}
        <td>
          <div>Action</div>
        </td>
      </tr>
    </thead>
  );
};

export default AccountsHead;
