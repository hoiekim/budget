import { Transaction } from "common";
import { Sorter } from "client";
import { TransactionHeaders } from ".";
import { CSSProperties } from "react";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
  style?: CSSProperties;
}

const TransactionsHead = ({ sorter, getHeader, style }: Props) => {
  const { setSortBy, getArrow, getVisible } = sorter;

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
        </div>
      );
    });

  return (
    <div className="TransactionsHead" style={style}>
      {headerComponents}
    </div>
  );
};

export default TransactionsHead;
