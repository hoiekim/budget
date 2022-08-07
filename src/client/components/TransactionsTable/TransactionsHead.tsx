import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
}

const TransactionsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;

  const headerKeys: (keyof TransactionHeaders)[] = [
    "authorized_date",
    "merchant_name",
    "amount",
    "account",
    "institution",
    "category",
  ];

  const headerComponents = headerKeys.map((key, i) => {
    if (getVisible(key)) {
      return (
        <td key={`transactions_header_${i}`}>
          <div>
            <button onClick={() => setSortBy(key)}>
              {getHeader(key)} {getArrow(key)}
            </button>
            <button onClick={() => toggleVisible(key)}>✕</button>
          </div>
        </td>
      );
    } else return <></>;
  });

  return (
    <thead>
      <tr>{headerComponents}</tr>
    </thead>
  );
};

export default TransactionsHead;
