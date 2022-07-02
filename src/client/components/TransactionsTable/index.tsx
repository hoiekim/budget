import { Transaction } from "server";
import { useAppContext, useLocalStorage } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";
import "./index.css";

export type SortingKey = keyof Transaction | "account" | "institution";
export type SortingOptions = Map<SortingKey, "ascending" | "descending">;
export type VisibilityOptions = { [k in keyof Transaction]?: boolean } & {
  account?: boolean;
  institution?: boolean;
};

class Comparable<T> {
  A: T;
  B: T;
  a: string | number | Date = 0;
  b: string | number | Date = 0;

  constructor(a: T, b: T) {
    this.A = a;
    this.B = b;
  }

  format = (callback: (e: T) => any) => {
    const a = callback(this.A);
    const b = callback(this.B);

    if (
      (typeof a === "number" && typeof b === "number") ||
      (typeof b === "string" && typeof b === "string") ||
      (a instanceof Date && b instanceof Date)
    ) {
      this.a = a;
      this.b = b;
    } else {
      this.a = 0;
      this.b = 0;
    }
  };
}

const TransactionsTable = () => {
  const { transactions, accounts, institutions } = useAppContext();

  const [sortingOptions, setSortingOptions] = useLocalStorage<SortingOptions>(
    "map_sortingOptions",
    new Map()
  );
  const [visibilityOptions, setVisibilityOptions] = useLocalStorage<VisibilityOptions>(
    "visibilityOptions",
    {}
  );

  const transactionsArray = Array.from(transactions.values());

  Array.from(sortingOptions).forEach(async (e) => {
    const [key, option] = e;
    transactionsArray.sort((a, b) => {
      const comparable = new Comparable(a, b);

      if (key === "authorized_date") {
        comparable.format((e) => new Date(e.authorized_date || e.date));
      } else if (key === "merchant_name") {
        comparable.format((e) => e.merchant_name || e.name);
      } else if (key === "account") {
        comparable.format((e) => accounts.get(e.account_id)?.name);
      } else if (key === "institution") {
        comparable.format((e) => {
          const account = accounts.get(e.account_id);
          return institutions.get(account?.institution_id || "")?.name;
        });
      } else if (key === "category") {
        comparable.format((e) => e.category && e.category[0]);
      } else {
        comparable.format((e) => e[key]);
      }

      const isABiggerThanB = comparable.a > comparable.b;
      const aMinusB = comparable.a === comparable.b ? 0 : isABiggerThanB ? 1 : -1;

      let result: number = 0;

      if (option === "ascending") result = aMinusB;
      else result = -aMinusB;
      return result;
    });
  });

  const transactionRows = transactionsArray.map((e, i) => {
    return <TransactionRow key={i} transaction={e} />;
  });

  return (
    <div className="TransactionsTable">
      <div>Transactions:</div>
      <table>
        <TransactionsHead
          options={{
            sortingOptions,
            setSortingOptions,
            visibilityOptions,
            setVisibilityOptions,
          }}
        />
        <tbody>{transactionRows}</tbody>
      </table>
    </div>
  );
};

export default TransactionsTable;
