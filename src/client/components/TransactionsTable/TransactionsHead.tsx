import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";
import { CSSProperties, useMemo } from "react";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
  style?: CSSProperties;
}

const TransactionsHead = ({ sorter, getHeader, style }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible, visibles } = sorter;

  const headerKeys: (keyof TransactionHeaders)[] = [
    "authorized_date",
    "merchant_name",
    "amount",
    "account",
    "budget",
    "category",
  ];

  const headerComponents = headerKeys
    .filter((key) => getVisible(key))
    .map((key, i) => {
      return (
        <div key={`transactions_header_${i}`}>
          <button onClick={() => setSortBy(key)}>
            {getHeader(key)} {getArrow(key)}
          </button>
          <button onClick={() => toggleVisible(key)}>✕</button>
        </div>
      );
    });

  const hiddenColumns = useMemo(() => {
    return Object.entries(visibles)
      .filter(([key, value]) => !value)
      .map(([key, value], i) => {
        return (
          <div key={`transactions_hidden_column_${i}`} className="hiddenColumn">
            <button onClick={() => toggleVisible(key as keyof typeof visibles)}>
              {getHeader(key as keyof typeof visibles)}
            </button>
          </div>
        );
      });
  }, [getHeader, toggleVisible, visibles]);

  return (
    <div className="TransactionsHead" style={style}>
      {headerComponents}
      {hiddenColumns}
    </div>
  );
};

export default TransactionsHead;
