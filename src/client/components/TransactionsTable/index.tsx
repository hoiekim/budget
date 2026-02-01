import { InvestmentTransaction, SplitTransaction, Transaction } from "client";
import TransactionRow from "./TransactionRow";
import InvestmentTransactionRow from "./InvestmentTransactionRow";
import "./index.css";

interface Props {
  transactions: (Transaction | InvestmentTransaction | SplitTransaction)[];
}

export const TransactionsTable = ({ transactions }: Props) => {
  const transactionRows = transactions.map((e) => {
    if (e instanceof InvestmentTransaction) {
      return <InvestmentTransactionRow key={e.id} investmentTransaction={e} />;
    } else {
      return <TransactionRow key={e.id} transaction={e} />;
    }
  });

  return (
    <div className="TransactionsTable">
      <div>
        <div>{transactionRows}</div>
      </div>
    </div>
  );
};
