import { Transaction } from "server";
import { Sorter } from "client";
import { TransactionHeaders } from ".";

interface Props {
  sorter: Sorter<Transaction, TransactionHeaders>;
}

const TransactionsHead = ({ sorter }: Props) => {
  const { setSortBy, getArrow, getVisible, toggleVisible } = sorter;
  return (
    <thead>
      <tr>
        {getVisible("authorized_date") && (
          <td>
            <div>
              <button onClick={() => setSortBy("authorized_date")}>
                Date {getArrow("authorized_date")}
              </button>
              <button onClick={() => toggleVisible("authorized_date")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("merchant_name") && (
          <td>
            <div>
              <button onClick={() => setSortBy("merchant_name")}>
                Name {getArrow("merchant_name")}
              </button>
              <button onClick={() => toggleVisible("merchant_name")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("amount") && (
          <td>
            <div>
              <button onClick={() => setSortBy("amount")}>
                Amount {getArrow("amount")}
              </button>
              <button onClick={() => toggleVisible("amount")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("account") && (
          <td>
            <div>
              <button onClick={() => setSortBy("account")}>
                Account {getArrow("account")}
              </button>
              <button onClick={() => toggleVisible("account")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("institution") && (
          <td>
            <div>
              <button onClick={() => setSortBy("institution")}>
                Institution {getArrow("institution")}
              </button>
              <button onClick={() => toggleVisible("institution")}>✕</button>
            </div>
          </td>
        )}
        {getVisible("category") && (
          <td>
            <div>
              <button onClick={() => setSortBy("category")}>
                Category {getArrow("category")}
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
