import { useState, useContext, useRef, ChangeEventHandler } from "react";
import { Transaction } from "server";
import { Context, call } from "client";
import { InstitutionTag } from "client/components";

interface Props {
  transaction: Transaction;
}

const TransactionRow = ({ transaction }: Props) => {
  const { accounts } = useContext(Context);
  const { transaction_id, account_id, authorized_date, date, name, amount, category } =
    transaction;

  const [categoryInput, setCategoryInput] = useState(category ? category.join(", ") : "");

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
      // TODO: Parse category input value into array
      call("/api/transaction-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id, category: [value] }),
      });
    }, 500);
  };

  return (
    <tr>
      <td>
        <div>{authorized_date || date}</div>
      </td>
      <td>
        <div>{name}</div>
      </td>
      <td>
        <div>{amount}</div>
      </td>
      <td>
        <div>{account?.name}</div>
      </td>
      <td>
        <InstitutionTag institution_id={institution_id} />
      </td>
      <td>
        <input onChange={onChangeCategoryInput} value={categoryInput} />
      </td>
    </tr>
  );
};

export default TransactionRow;
