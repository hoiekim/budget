import {
  useState,
  useEffect,
  useRef,
  ChangeEventHandler,
  MouseEventHandler,
  useMemo,
} from "react";
import { InstitutionSpan, PlaidLinkButton } from "client/components";
import { call, Sorter, useAppContext, numberToCommaString } from "client";
import { Account } from "server";
import { AccountHeaders } from ".";
import "./index.css";

interface Props {
  account: Account;
  sorter: Sorter<Account, AccountHeaders>;
}

const AccountRow = ({ account, sorter }: Props) => {
  const { getVisible } = sorter;
  const { account_id, balances, custom_name, name, institution_id, label } = account;

  const { user, accounts, setAccounts, setTransactions, institutions, items, budgets } =
    useAppContext();

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || "";
  });
  const [nameInput, setNameInput] = useState(custom_name || name);

  useEffect(() => {
    setNameInput(custom_name || name);
  }, [custom_name, name, setNameInput]);

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option
          key={`account_${account_id}_budget_option_${e.budget_id}`}
          value={e.budget_id}
        >
          {e.name}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [account_id, budgets]);

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value || "");

    const r = await call.post("/api/account", {
      account_id,
      label: { budget_id: value || null },
    });

    if (r.status === "success") {
      setAccounts((oldAccounts) => {
        const newAccounts = new Map(oldAccounts);
        const newAccount = { ...account };
        newAccount.label.budget_id = value || null;
        newAccounts.set(account_id, newAccount);
        return newAccounts;
      });
    } else {
      setSelectedBudgetIdLabel(selectedBudgetIdLabel);
    }
  };

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const onChangeNameInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    if (!account_id) return;
    const { value } = e.target;
    setNameInput(value);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      call.post("/api/account", { account_id, custom_name: value }).then((r) => {
        if (r.status === "success") {
          setAccounts((oldAccounts) => {
            const oldAccount = oldAccounts.get(account_id);
            if (!oldAccount) return oldAccounts;
            const newAccounts = new Map(oldAccounts);
            const newAccount = { ...oldAccount, custom_name: value };
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
        const accountsInItem: Account[] = [];
        accounts.forEach((e) => {
          if (e.item_id === item_id) accountsInItem.push(e);
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
          newTransactions.forEach((e) => {
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
    call.post("/api/account", { account_id, hide: true }).then((r) => {
      if (r.status === "success") {
        setAccounts((oldAccounts) => {
          const newAccounts = new Map(oldAccounts);
          const newAccount = oldAccounts.get(account_id) || account;
          newAccount.hide = true;
          newAccounts.set(account_id, newAccount);
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
    <div className="AccountRow">
      {getVisible("balances") && <div>{formattedBalancesText}</div>}
      {getVisible("custom_name") && (
        <div>
          <input onChange={onChangeNameInput} value={nameInput} />
        </div>
      )}
      {getVisible("institution") && (
        <div>
          <InstitutionSpan institution_id={institution_id} />
        </div>
      )}
      <div className="budgetAction">
        {getVisible("budget") && (
          <div>
            <select value={selectedBudgetIdLabel} onChange={onChangeBudgetSelect}>
              <option value="">Select Budget</option>
              {budgetOptions}
            </select>
          </div>
        )}
        {getVisible("action") && (
          <div className="action">
            {item ? (
              <PlaidLinkButton item={item}>Update</PlaidLinkButton>
            ) : (
              <button disabled>Update</button>
            )}
            <button onClick={onClickRemove}>Remove</button>
            <button onClick={onClickHide}>Hide</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AccountRow;
