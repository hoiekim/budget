import { CSSProperties } from "react";
import { InvestmentTransaction, SplitTransaction, Transaction } from "common";
import { InvestmentTransactionHeaders, Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<
    Transaction | InvestmentTransaction | SplitTransaction,
    TransactionHeaders & InvestmentTransactionHeaders
  >;
  getHeaderName: (key: keyof TransactionHeaders | keyof InvestmentTransactionHeaders) => string;
  headerKeys: (keyof TransactionHeaders | keyof InvestmentTransactionHeaders)[];
  style?: CSSProperties;
}

export const TransactionsHead = ({ sorter, getHeaderName, headerKeys, style }: Props) => {
  const { setSortBy, getArrow, sortings } = sorter;

  const sortOrder = Array.from(sortings.keys());

  const headerComponents = headerKeys
    .sort((a, b) => sortOrder.indexOf(b) - sortOrder.indexOf(a))
    .map((key, i) => {
      return (
        <div key={`transactions_header_${key}`}>
          <button onClick={() => setSortBy(key)}>
            {getHeaderName(key)} {getArrow(key)}
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
