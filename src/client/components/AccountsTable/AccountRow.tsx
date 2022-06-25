import { useState, useRef, ChangeEventHandler } from "react";
import { InstitutionTag } from "client/components";
import { call } from "client";
import { Account } from "server";

interface Props {
  account: Account;
}

const AccountRow = ({ account }: Props) => {
  const { account_id, balances, name, institution_id } = account;

  const [nameInput, setNameInput] = useState(name);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const onChangeNameInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    const { value } = e.target;
    setNameInput(value);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      call.post("/api/account", { account_id, name: value });
    }, 500);
  };

  return (
    <tr>
      <td>
        <div>
          {balances.available} / {balances.current} {balances.iso_currency_code}
        </div>
      </td>
      <td>
        <input onChange={onChangeNameInput} value={nameInput} />
      </td>
      <td>
        <div>{account.official_name}</div>
      </td>
      <td>
        <InstitutionTag institution_id={institution_id} />
      </td>
    </tr>
  );
};

export default AccountRow;
