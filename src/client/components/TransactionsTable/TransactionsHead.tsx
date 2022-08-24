import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";
import { useMemo } from "react";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
}

const TransactionsHead = ({ sorter, getHeader }: Props) => {
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
    <div className="TransactionsHead">
      {headerComponents}
      {hiddenColumns}
    </div>
  );
};

export default TransactionsHead;
