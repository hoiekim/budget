import { useState, useEffect, useRef, ChangeEventHandler } from "react";
import { Transaction } from "server";
import { useAppContext, call, Sorter } from "client";
import { InstitutionSpan } from "client/components";
import { TransactionHeaders } from ".";

interface Props {
  transaction: Transaction;
  sorter: Sorter<Transaction, TransactionHeaders>;
}

const TransactionRow = ({ transaction, sorter }: Props) => {
  const { getVisible } = sorter;
  const { transactions, setTransactions, accounts } = useAppContext();
  const {
    transaction_id,
    account_id,
    authorized_date,
    date,
    merchant_name,
    name,
    amount,
    category,
  } = transaction;

  const [categoryInput, setCategoryInput] = useState(category ? category.join(", ") : "");

  useEffect(() => {
    setCategoryInput(category ? category.join(", ") : "");
  }, [category, setCategoryInput]);

  const account = accounts.get(account_id);
  const institution_id = account?.institution_id;

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const onChangeCategoryInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    const { value } = e.target;
    setCategoryInput(value);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      const parsedCategory = value
        .split(",")
        .map((e) => e.replace(/^\s+|\s+$|\s+(?=\s)/g, ""));

      call.post("/api/transaction", { transaction_id, category: parsedCategory });

      transaction.category = parsedCategory;

      const newTransactions = new Map(transactions);
      newTransactions.set(transaction_id, transaction);
      setTransactions(newTransactions);
    }, 500);
  };

  return (
    <tr>
      {getVisible("authorized_date") && (
        <td>
          <div>{authorized_date || date}</div>
        </td>
      )}
      {getVisible("merchant_name") && (
        <td>
          <div>{merchant_name || name}</div>
        </td>
      )}
      {getVisible("amount") && (
        <td>
          <div>{amount}</div>
        </td>
      )}
      {getVisible("account") && (
        <td>
          <div>{account?.name}</div>
        </td>
      )}
      {getVisible("institution") && (
        <td>
          <div>
            <InstitutionSpan institution_id={institution_id} />
          </div>
        </td>
      )}
      {getVisible("category") && (
        <td>
          <div>
            <input onChange={onChangeCategoryInput} value={categoryInput} />
          </div>
        </td>
      )}
    </tr>
  );
};

export default TransactionRow;
