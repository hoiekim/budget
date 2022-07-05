import { SetSortBy, GetArrow } from "client";
import { TransactionHeaders } from ".";

interface Props<T> {
  setSortBy: SetSortBy<T>;
  getArrow: GetArrow<T>;
}

const TransactionsHead = ({ setSortBy, getArrow }: Props<TransactionHeaders>) => {
  return (
    <thead>
      <tr>
        <td>
          <div>
            <button onClick={() => setSortBy("authorized_date")}>
              Date {getArrow("authorized_date")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => setSortBy("merchant_name")}>
              Name {getArrow("merchant_name")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => setSortBy("amount")}>
              Amount {getArrow("amount")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => setSortBy("account")}>
              Account {getArrow("account")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => setSortBy("institution")}>
              Institution {getArrow("institution")}
            </button>
          </div>
        </td>
        <td>
          <div>
            <button onClick={() => setSortBy("category")}>
              Category {getArrow("category")}
            </button>
          </div>
        </td>
      </tr>
    </thead>
  );
};

export default TransactionsHead;
