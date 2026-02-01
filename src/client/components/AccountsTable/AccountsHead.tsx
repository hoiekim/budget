import { useMemo } from "react";
import { Account, Sorter } from "client";
import { AccountHeaders } from ".";

interface Props {
  sorter: Sorter<Account, AccountHeaders>;
  getHeader: (key: keyof AccountHeaders) => string;
}

const AccountsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, toggleVisible, visibles } = sorter;

  const hiddenColumns = useMemo(() => {
    return Object.entries(visibles)
      .filter(([_, value]) => !value)
      .map(([key, _]) => {
        return (
          <div key={`accounts_hidden_column_${key}`} className="hiddenColumn">
            <button onClick={() => toggleVisible(key as keyof typeof visibles)}>
              {getHeader(key as keyof typeof visibles)}
            </button>
          </div>
        );
      });
  }, [getHeader, toggleVisible, visibles]);

  const headerKeys: (keyof AccountHeaders)[] = [
    "balances",
    "custom_name",
    "institution",
    "budget",
    "action",
  ];

  const headerComponents = headerKeys.map((key, i) => {
    return (
      <div key={`accounts_header_${key}`}>
        <button onClick={() => setSortBy(key)}>
          {getHeader(key)} {getArrow(key)}
        </button>
        <button onClick={() => toggleVisible(key)}>✕</button>
      </div>
    );
  });

  return (
    <div className="AccountsHead">
      {headerComponents}
      {hiddenColumns}
    </div>
  );
};

export default AccountsHead;
