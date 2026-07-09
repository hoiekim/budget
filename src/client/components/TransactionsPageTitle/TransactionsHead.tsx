import { CSSProperties, useEffect, useRef, useState } from "react";
import {
  InvestmentTransaction,
  SplitTransaction,
  Transaction,
  InvestmentTransactionHeaders,
  Sorter,
} from "client";
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

  const init = useRef<boolean>(false);
  const [sortOrder, setSortOrder] = useState(Array.from(sortings.keys()));

  useEffect(() => {
    if (init.current) return;
    setSortOrder(Array.from(sortings.keys()));
    init.current = true;
  }, [sortings]);

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
