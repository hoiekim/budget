import { InvestmentTransaction } from "common";
import { Sorter } from "client";
import { InvestmentTransactionHeaders } from ".";
import { CSSProperties } from "react";

interface Props {
  sorter: Sorter<InvestmentTransaction, InvestmentTransactionHeaders>;
  getHeader: (key: keyof InvestmentTransactionHeaders) => string;
  style?: CSSProperties;
}

const TransactionsHead = ({ sorter, getHeader, style }: Props) => {
  const { setSortBy, getArrow, sortings } = sorter;

  const headerKeys: (keyof InvestmentTransactionHeaders)[] = ["date", "amount", "account"];

  const sortOrder = Array.from(sortings.keys());

  const headerComponents = headerKeys
    .sort((a, b) => sortOrder.indexOf(b) - sortOrder.indexOf(a))
    .map((key, i) => {
      return (
        <div key={`transactions_header_${key}`}>
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
