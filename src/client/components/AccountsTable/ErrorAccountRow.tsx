import { MouseEventHandler } from "react";
import { InstitutionSpan, PlaidLinkButton } from "client/components";
import { call, Sorter, useAppContext } from "client";
import { Account } from "server";
import { AccountHeaders } from ".";

export interface ErrorAccount {
  item_id: string;
  institution_id?: string;
}

interface Props {
  errorAccount: ErrorAccount;
  sorter: Sorter<Account, AccountHeaders>;
}

const ErrorAccountRow = ({ errorAccount, sorter }: Props) => {
  const { getVisible } = sorter;
  const { institution_id } = errorAccount;

  const { user, setUser, institutions, items } = useAppContext();

  const item = items.get(errorAccount.item_id);
  const institution = institutions.get(errorAccount.institution_id);

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
            return false;
          });
      });
    }
  };

  return (
    <tr>
      {getVisible("balances") && (
        <td>
          <div>Unknown</div>
        </td>
      )}
      {getVisible("name") && (
        <td>
          <div>Unknown</div>
        </td>
      )}
      {getVisible("official_name") && (
        <td>
          <div>Unknown</div>
        </td>
      )}
      {getVisible("institution") && (
        <td>
          <div>
            <InstitutionSpan institution_id={institution_id} />
          </div>
        </td>
      )}
      {getVisible("action") && (
        <td>
          <div>
            <PlaidLinkButton item={item}>Fix</PlaidLinkButton>
            <button onClick={onClickRemove}>Remove</button>
            <button disabled>Hide</button>
          </div>
        </td>
      )}
    </tr>
  );
};

export default ErrorAccountRow;
