import { useMemo } from "react";
import { IsNow, useAppContext } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";

const Transactions = () => {
  const { transactions, accounts, selectedInterval } = useAppContext();

  const transactionsArray = useMemo(() => {
    const array: Transaction[] = [];
    const isNow = new IsNow();
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = isNow.within(selectedInterval).from(transactionDate);
      if (!hidden && within) array.push(e);
    });
    return array;
  }, [transactions, accounts, selectedInterval]);

  return (
    <div className="Transactions">
      <TransactionsTable transactionsArray={transactionsArray} />
    </div>
  );
};

export default Transactions;
