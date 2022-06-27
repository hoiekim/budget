import { useState, useRef, ChangeEventHandler } from "react";
import { Transaction } from "server";
import { useAppContext, call } from "client";
import { InstitutionTag } from "client/components";

interface Props {
  transaction: Transaction;
}

const TransactionRow = ({ transaction }: Props) => {
  const { accounts } = useAppContext();
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
      const parsedCategory = value
        .split(",")
        .map((e) => e.replace(/^\s+|\s+$|\s+(?=\s)/g, ""));

      call.post("/api/transaction", { transaction_id, category: parsedCategory });
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
