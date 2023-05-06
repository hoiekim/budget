import { useMemo } from "react";
import { Account } from "common";
import { Sorter } from "client";
import { AccountHeaders } from ".";

interface Props {
  sorter: Sorter<Account, AccountHeaders>;
  getHeader: (key: keyof AccountHeaders) => string;
}

const AccountsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible, visibles } = sorter;

  const hiddenColumns = useMemo(() => {
    return Object.entries(visibles)
      .filter(([key, value]) => !value)
      .map(([key, value], i) => {
        return (
          <div key={`accounts_hidden_column_${i}`} className="hiddenColumn">
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

  const headerComponents = headerKeys
    .filter((key) => getVisible(key))
    .map((key, i) => {
      return (
        <div key={`accounts_header_${i}`}>
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
