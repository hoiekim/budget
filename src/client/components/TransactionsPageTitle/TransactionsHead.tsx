import { CSSProperties, useState } from "react";
import { InvestmentTransactionHeaders, Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<TransactionHeaders & InvestmentTransactionHeaders>;
  getHeaderName: (key: keyof TransactionHeaders | keyof InvestmentTransactionHeaders) => string;
  headerKeys: (keyof TransactionHeaders | keyof InvestmentTransactionHeaders)[];
  style?: CSSProperties;
}

export const TransactionsHead = ({ sorter, getHeaderName, headerKeys, style }: Props) => {
  const { setSortBy, getArrow, sortings } = sorter;

  // Captured at mount and deliberately not updated: `setSortBy` moves
  // the clicked key to the end of `sortings`, so following it live would
  // make the buttons jump under the cursor. A stored-slot swap remounts
  // this component instead — see the React `key` at its call site.
  const [sortOrder] = useState(() => Array.from(sortings.keys()));

  const headerComponents = headerKeys
    .sort((a, b) => sortOrder.indexOf(b) - sortOrder.indexOf(a))
    .map((key, _i) => {
      return (
        <div key={`transactions_header_${key}`}>
          <button onClick={() => setSortBy(key)}>
            {getHeaderName(key)} {getArrow(key)}
          </button>
        </div>
      );
    });

  return (
    <div className="TransactionsHead sticky" style={style}>
      {headerComponents}
    </div>
  );
};
