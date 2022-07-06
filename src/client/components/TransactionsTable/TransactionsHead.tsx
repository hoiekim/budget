import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
  getHeader: (key: keyof TransactionHeaders) => string;
}

const TransactionsHead = ({ sorter, getHeader }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;
  return (
    <thead>
      <tr>
        {getVisible("authorized_date") && (
          <td>
            <div>
              <button onClick={() => setSortBy("authorized_date")}>
                {getHeader("authorized_date")} {getArrow("authorized_date")}
              </button>
              <button onClick={() => toggleVisible("authorized_date")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("merchant_name") && (
          <td>
            <div>
              <button onClick={() => setSortBy("merchant_name")}>
                {getHeader("merchant_name")} {getArrow("merchant_name")}
              </button>
              <button onClick={() => toggleVisible("merchant_name")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("amount") && (
          <td>
            <div>
              <button onClick={() => setSortBy("amount")}>
                {getHeader("amount")} {getArrow("amount")}
              </button>
              <button onClick={() => toggleVisible("amount")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("account") && (
          <td>
            <div>
              <button onClick={() => setSortBy("account")}>
                {getHeader("account")} {getArrow("account")}
              </button>
              <button onClick={() => toggleVisible("account")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("institution") && (
          <td>
            <div>
              <button onClick={() => setSortBy("institution")}>
                {getHeader("institution")} {getArrow("institution")}
              </button>
              <button onClick={() => toggleVisible("institution")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("category") && (
          <td>
            <div>
              <button onClick={() => setSortBy("category")}>
                {getHeader("category")} {getArrow("category")}
              </button>
              <button onClick={() => toggleVisible("category")}>✕</button>
            </div>
          </td>
        )}
      </tr>
    </thead>
  );
};

export default TransactionsHead;
