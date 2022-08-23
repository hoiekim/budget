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
    "budget",
  ];

  const headerComponents = headerKeys
    .filter((key) => getVisible(key))
    .map((key, i) => {
      return (
        <div key={`accounts_header_${i}`}>
          <div>
            <button onClick={() => setSortBy(key)}>
              {getHeader(key)} {getArrow(key)}
            </button>
            <button onClick={() => toggleVisible(key)}>✕</button>
          </div>
        </div>
      );
    });

  return (
    <div>
      <div>
        {headerComponents}
        {getVisible("action") && (
          <div>
            <div>
              <span>{getHeader("action")}</span>
              <button onClick={() => toggleVisible("action")}>✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AccountsHead;
