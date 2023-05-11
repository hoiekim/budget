import {
  useState,
  useEffect,
  useRef,
  ChangeEventHandler,
  MouseEventHandler,
  useMemo,
} from "react";
import {
  Transaction,
  InvestmentTransaction,
  Account,
  numberToCommaString,
  Timeout,
} from "common";
import { call, useAppContext, PATH, TransactionsPageParams } from "client";
import { InstitutionSpan, PlaidLinkButton, Graph } from "client/components";
import { Point, GraphData } from "client/components/Graph";
import "./index.css";

interface Props {
  account: Account;
}

const AccountRow = ({ account }: Props) => {
  const { account_id, balances, custom_name, name, institution_id, label, type } =
    account;

  const {
    user,
    accounts,
    setAccounts,
    transactions,
    setTransactions,
    investmentTransactions,
    institutions,
    items,
    budgets,
    viewDate,
    router,
  } = useAppContext();

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
        const newAccount = new Account(account);
        newAccount.label.budget_id = value || null;
        newAccounts.set(account_id, newAccount);
        return newAccounts;
      });
    } else {
      setSelectedBudgetIdLabel(selectedBudgetIdLabel);
    }
  };

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
            const newAccount = new Account({ ...oldAccount, custom_name: value });
            newAccounts.set(account_id, newAccount);
            return newAccounts;
          });
        }
      });
    }, 500);
  };

  const item = items.get(account.item_id);
  const institution = institutions.get(account.institution_id);

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
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

  const onClickHide: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!account_id) return;
    call.post("/api/account", { account_id, hide: true }).then((r) => {
      if (r.status === "success") {
        setAccounts((oldAccounts) => {
          const newAccounts = new Map(oldAccounts);
          const oldAccount = oldAccounts.get(account_id);
          if (!oldAccount) return newAccounts;
          const newAccount = new Account({ ...oldAccount, hide: true });
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

  const graphData: GraphData | undefined = useMemo(() => {
    if (type === "credit") return;

    const balanceHistory: number[] = [current || 0];

    const translate = (transaction: Transaction | InvestmentTransaction) => {
      const { authorized_date, date, amount } = transaction;
      if (account_id !== transaction.account_id) return;
      const transactionDate = new Date(authorized_date || date);
      const span = viewDate.getSpanFrom(transactionDate) + 1;
      if (!balanceHistory[span]) balanceHistory[span] = 0;
      if (type === "investment") {
        const { price, quantity } = transaction as InvestmentTransaction;
        balanceHistory[span] -= price * quantity;
      } else {
        balanceHistory[span] += amount;
      }
    };

    transactions.forEach(translate);
    investmentTransactions.forEach(translate);

    const { length } = balanceHistory;

    if (length < 2) return;

    let min = current || 0;
    let max = current || 0;

    for (let i = 1; i < length; i++) {
      if (!balanceHistory[i]) balanceHistory[i] = 0;
      balanceHistory[i] += balanceHistory[i - 1];
      min = Math.min(min, balanceHistory[i]);
      max = Math.max(max, balanceHistory[i]);
    }

    const maxDigits = max.toFixed(0).length - 1;
    const fixer = Math.pow(10, maxDigits - 1);
    max = Math.ceil(max / fixer);
    min = Math.floor(min / fixer);

    let i = 0;
    while ((max - min) % 4) {
      if (i % 2) min -= 1;
      else max += 1;
      i++;
    }

    max *= fixer;
    min *= fixer;

    const points = balanceHistory.reverse().map((e, i): Point => {
      const x = length === 1 ? 0.5 : i / (length - 1);
      const y = max === min ? 0.5 : (e - min) / (max - min);
      return [x, y];
    });

    return { points, range: { y: [min, max], x: [0, length - 1] }, iso_currency_code };
  }, [
    transactions,
    current,
    viewDate,
    account_id,
    iso_currency_code,
    type,
    investmentTransactions,
  ]);

  const onClickAccount = () => {
    const paramObj: TransactionsPageParams = { account_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  return (
    <div className="AccountRow" onClick={onClickAccount}>
      <div>{formattedBalancesText}</div>
      <div>
        <input
          onClick={(e) => e.stopPropagation()}
          onChange={onChangeNameInput}
          value={nameInput}
        />
      </div>
      <div>
        <InstitutionSpan institution_id={institution_id} />
      </div>
      <div className="budgetAction">
        <div>
          <select
            value={selectedBudgetIdLabel}
            onClick={(e) => e.stopPropagation()}
            onChange={onChangeBudgetSelect}
          >
            <option value="">Select Budget</option>
            {budgetOptions}
          </select>
        </div>
        <div className="action">
          <PlaidLinkButton item={item}>Update</PlaidLinkButton>
          <button onClick={onClickRemove}>Remove</button>
          <button onClick={onClickHide}>Hide</button>
        </div>
      </div>
      {!!graphData && <Graph data={graphData} />}
    </div>
  );
};

export default AccountRow;
