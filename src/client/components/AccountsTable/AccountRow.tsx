import { useState, useRef, ChangeEventHandler, MouseEventHandler } from "react";
import { InstitutionSpan, PlaidLinkButton } from "client/components";
import { call, Sorter, useAppContext } from "client";
import { Account } from "server";

export type ErrorAccount = Omit<Account, "institution_id" | "item_id"> & Partial<Account>;

interface Props {
  account: Account | ErrorAccount;
  sorter: Sorter;
}

const AccountRow = ({ account, sorter }: Props) => {
  const { getVisible } = sorter;
  const { account_id, balances, name, institution_id } = account;

  const { user, setUser, institutions } = useAppContext();

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

  const item = user?.items.find((e) => e.item_id === account.item_id);
  const institution = institutions.get(account.institution_id);

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = () => {
    if (!item || !user) return;

    const confirmed = window.confirm(
      `Do you want to remove all accounts in ${
        institution?.name || "Unknown"
      } institution from Budget?`
    );

    if (confirmed) {
      const { item_id } = item;
      call.delete(`/api/item?id=${item_id}`).then((r) => {
        if (r.status === "success")
          user?.items.find((e, i) => {
            if (e.item_id === item_id) {
              setUser((oldUser) => {
                if (!oldUser) return;
                const newUser = { ...oldUser };
                newUser.items.splice(i, 1);
                return newUser;
              });
              return true;
            }
          });
      });
    }
  };

  return (
    <tr>
      {getVisible("balances") && (
        <td>
          <div>
            {balances
              ? `${balances.available} / ${balances.current} ${balances.iso_currency_code}`
              : "Unknown"}
          </div>
        </td>
      )}
      {getVisible("name") && (
        <td>
          <div>
            {name ? <input onChange={onChangeNameInput} value={nameInput} /> : "Unknown"}
          </div>
        </td>
      )}
      <td>
        <div>{account.official_name || "Unknown"}</div>
      </td>
      {getVisible("institution") && (
        <td>
          <div>
            <InstitutionSpan institution_id={institution_id} />
            <button onClick={onClickRemove}>✕</button>
          </div>
        </td>
      )}
      <td>
        <div>
          <PlaidLinkButton item={item}>Reconnect</PlaidLinkButton>
        </div>
      </td>
    </tr>
  );
};

export default AccountRow;
