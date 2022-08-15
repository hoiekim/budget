import { Account } from "server";
import { Sorter } from "client";
import { AccountHeaders } from ".";

interface Props {
  sorter: Sorter<Account, AccountHeaders>;
  getHeader: (key: keyof AccountHeaders) => string;
}

const AccountsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;

  const headerKeys: (keyof AccountHeaders)[] = [
    "balances",
    "custom_name",
    "official_name",
    "institution",
  ];

  const headerComponents = headerKeys
    .filter((key) => getVisible(key))
    .map((key, i) => {
      return (
        <td key={`accounts_header_${i}`}>
          <div>
            <button onClick={() => setSortBy(key)}>
              {getHeader(key)} {getArrow(key)}
            </button>
            <button onClick={() => toggleVisible(key)}>✕</button>
          </div>
        </td>
      );
    });

  return (
    <thead>
      <tr>
        {headerComponents}
        {getVisible("action") && (
          <td>
            <div>
              <span>{getHeader("action")}</span>
              <button onClick={() => toggleVisible("action")}>✕</button>
            </div>
          </td>
        )}
      </tr>
    </thead>
  );
};

export default AccountsHead;
