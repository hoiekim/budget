import { Transaction } from "server";
import { useAppContext, useLocalStorage } from "client";
import TransactionRow from "./TransactionRow";
import TransactionsHead from "./TransactionsHead";

export type SortingOptions = { [k in keyof Transaction]?: "ascending" | "descending" };
export type VisibilityOptions = { [k in keyof Transaction]?: boolean };

const TransactionsTable = () => {
  const { transactions } = useAppContext();

  const [sortingOptions, setSortingOptions] = useLocalStorage<SortingOptions>(
    "sortingOptions",
    {}
  );
  const [visibilityOptions, setVisibilityOptions] = useLocalStorage<VisibilityOptions>(
    "visibilityOptions",
    {}
  );

  const transactionRows = Array.from(transactions.values()).map((e, i) => {
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
