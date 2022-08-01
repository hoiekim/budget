import {
  useState,
  useEffect,
  useRef,
  ChangeEventHandler,
  MouseEventHandler,
} from "react";
import { InstitutionSpan, PlaidLinkButton } from "client/components";
import { call, Sorter, useAppContext, numberToCommaString } from "client";
import { Account } from "server";
import { AccountHeaders } from ".";

interface Props {
  account: Account;
  sorter: Sorter<Account, AccountHeaders>;
}

const AccountRow = ({ account, sorter }: Props) => {
  const { getVisible } = sorter;
  const { account_id, balances, name, official_name, institution_id } = account;

  const { user, setUser, accounts, setAccounts, setTransactions, institutions, items } =
    useAppContext();

  const [nameInput, setNameInput] = useState(name);

  useEffect(() => {
    setNameInput(name);
  }, [name, setNameInput]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const onChangeNameInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    if (!account_id) return;
    const { value } = e.target;
    setNameInput(value);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      call.post("/api/account", { account_id, name: value }).then((r) => {
        if (r.status === "success") {
          setAccounts((oldAccounts) => {
            const oldAccount = oldAccounts.get(account_id);
            if (!oldAccount) return oldAccounts;
            const newAccounts = new Map(oldAccounts);
            const newAccount = { ...oldAccount, name: value };
            newAccounts.set(account_id, newAccount);
            return newAccounts;
          });
        }
      });
    }, 500);
  };

  const item = items.get(account.item_id);
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
            return false;
          });

        const accountsInItem = Array.from(accounts.values()).filter((e) => {
          return e.item_id === item_id;
        });

        setAccounts((oldAccounts) => {
          const newAccounts = new Map(oldAccounts);
          accountsInItem.forEach((e) => {
            newAccounts.delete(e.account_id);
          });
          return newAccounts;
        });

        setTransactions((oldTransactions) => {
          const newTransactions = new Map(oldTransactions);
          Array.from(newTransactions.values()).forEach((e) => {
            if (accountsInItem.find((f) => e.account_id === f.account_id)) {
              newTransactions.delete(e.transaction_id);
            }
          });
          return newTransactions;
        });
      });
    }
  };

  const onClickHide: MouseEventHandler<HTMLButtonElement> = () => {
    if (!account_id) return;
    call.post("/api/account", { account_id, config: { hide: true } }).then((r) => {
      if (r.status === "success") {
        setAccounts((oldAccounts) => {
          const newAccounts = new Map(oldAccounts);
          newAccounts.set(account_id, {
            ...(account as Account),
            config: { hide: true },
          });
          return newAccounts;
        });
      }
    });
  };

  let formattedBalancesText = "";

  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  if ([available, current].filter((e) => e).length === 2) {
    const formattedAvailable = numberToCommaString(available as number);
    const formattedCurrent = numberToCommaString(current as number);
    formattedBalancesText += `${formattedAvailable} / ${formattedCurrent}`;
  } else {
    const formattedBalance = numberToCommaString((available || current) as number);
    formattedBalancesText += formattedBalance;
  }

  if (iso_currency_code) {
    formattedBalancesText += " " + iso_currency_code;
  } else if (unofficial_currency_code) {
    formattedBalancesText += " " + unofficial_currency_code;
  }

  return (
    <tr>
      {getVisible("balances") && (
        <td>
          <div>{formattedBalancesText}</div>
        </td>
      )}
      {getVisible("name") && (
        <td>
          <div>
            {name ? <input onChange={onChangeNameInput} value={nameInput} /> : "Unknown"}
          </div>
        </td>
      )}
      {getVisible("official_name") && (
        <td>
          <div>{official_name || "Unknown"}</div>
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
            <button onClick={onClickHide}>Hide</button>
          </div>
        </td>
      )}
    </tr>
  );
};

export default AccountRow;
