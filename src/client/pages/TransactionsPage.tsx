import { useMemo } from "react";
import { IsDate, useAppContext } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";

const TransactionsPage = () => {
  const { transactions, accounts, selectedInterval, viewDate } = useAppContext();

  const transactionsArray = useMemo(() => {
    const array: Transaction[] = [];
    const isViewDate = new IsDate(viewDate);
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = isViewDate.within(selectedInterval).from(transactionDate);
      if (!hidden && within) array.push(e);
    });
    return array;
  }, [transactions, accounts, selectedInterval, viewDate]);

  return (
    <div className="TransactionsPage">
      <TransactionsTable transactionsArray={transactionsArray} />
    </div>
  );
};

export default TransactionsPage;
