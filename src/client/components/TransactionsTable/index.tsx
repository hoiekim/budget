import { InvestmentTransaction, SplitTransaction, Transaction, useAppContext } from "client";
import TransactionRow from "./TransactionRow";
import InvestmentTransactionRow from "./InvestmentTransactionRow";
import TransferRow from "./TransferRow";
import "./index.css";

interface Props {
  transactions: (Transaction | InvestmentTransaction | SplitTransaction)[];
}

export const TransactionsTable = ({ transactions }: Props) => {
  const { data } = useAppContext();
  const { transfers } = data;

  // Confirmed transfer pairs render as a single bundled row. Walk the
  // list in order, emitting one `TransferRow` for each pair the first
  // time we encounter either of its transaction ids; the second
  // sighting is suppressed so the two halves don't double-render.
  const renderedPairIds = new Set<string>();
  const transactionRows = transactions
    .map((e) => {
      if (e instanceof InvestmentTransaction) {
        // `isEditable={true}` exposes the row's budget/category selects
        // and the kebab that navigates to `PATH.TRANSACTION_DETAIL`. Kept
        // hidden by default in the row's Props for historical reasons;
        // flipped on here now that the detail page renders inv-tx (PR
        // #587) and manual entry needs the kebab as its primary reach
        // for anyone editing a `source='manual'` row post-creation.
        return <InvestmentTransactionRow key={e.id} investmentTransaction={e} isEditable={true} />;
      }
      // Bundled-pair dedup applies to parent Transaction rows only —
      // SplitTransactions inherit their parent's transaction_id but
      // never participate in a transfer pair (the detection engine
      // pairs whole transactions). Only CONFIRMED pairs bundle into
      // a TransferRow; suggested pairs still render as two
      // individual TransactionRows with the Confirm/Reject controls.
      if (e instanceof Transaction) {
        const lookedUp = transfers.byTransactionId.get(e.transaction_id);
        const pair = lookedUp?.status === "confirmed" ? lookedUp : undefined;
        if (pair) {
          if (renderedPairIds.has(pair.pair_id)) return null;
          renderedPairIds.add(pair.pair_id);
          return <TransferRow key={`transfer_${pair.pair_id}`} transactions={pair.transactions} />;
        }
      }
      return <TransactionRow key={e.id} transaction={e} />;
    })
    .filter((row) => row !== null);

  return (
    <div className="TransactionsTable">
      <div>
        <div>{transactionRows}</div>
      </div>
    </div>
  );
};
