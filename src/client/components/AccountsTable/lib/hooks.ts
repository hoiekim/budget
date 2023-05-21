import {
  ChangeEventHandler,
  Dispatch,
  MouseEventHandler,
  SetStateAction,
  useMemo,
  useRef,
} from "react";
import { Account, InvestmentTransaction, Timeout, Transaction, ViewDate } from "common";
import { GraphInput, PATH, TransactionsPageParams, call, useAppContext } from "client";

export const useGraph = (account: Account, viewDate: ViewDate) => {
  const {
    account_id,
    type,
    balances: { current },
  } = account;

  const { transactions, investmentTransactions } = useAppContext();

  const interval = viewDate.getInterval();
  const graphViewDate = useMemo(() => {
    return new Date() < viewDate.getDate() ? viewDate : new ViewDate(interval);
  }, [interval, viewDate]);

  const graphData: GraphInput = useMemo(() => {
    if (type === "credit") return {};

    const balanceHistory: number[] = [current || 0];

    const translate = (transaction: Transaction | InvestmentTransaction) => {
      const { authorized_date, date, amount } = transaction;
      if (account_id !== transaction.account_id) return;
      const transactionDate = new Date(authorized_date || date);
      const span = graphViewDate.getSpanFrom(transactionDate) + 1;
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

    if (length < 2) return {};

    const lengthFixer = 3 - ((length - 1) % 3);

    for (let i = 1; i < length; i++) {
      if (!balanceHistory[i]) balanceHistory[i] = 0;
      balanceHistory[i] += balanceHistory[i - 1];
    }

    balanceHistory.push(...new Array(lengthFixer));

    const sequence = balanceHistory.reverse();

    return { lines: [{ sequence, color: "#097" }] };
  }, [transactions, current, account_id, type, investmentTransactions, graphViewDate]);

  return { graphViewDate, graphData };
};

export const useEventHandlers = (
  account: Account,
  selectedBudgetIdLabel: string,
  setSelectedBudgetIdLabel: Dispatch<SetStateAction<string>>,
  setNameInput: Dispatch<SetStateAction<string>>
) => {
  const { account_id } = account;

  const { setAccounts, setTransactions, items, institutions, user, router } =
    useAppContext();

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

        setAccounts((oldAccounts) => {
          oldAccounts.forEach((e) => {
            if (e.item_id === item_id) accountsInItem.push(e);
          });
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

  const onClickAccount = () => {
    const paramObj: TransactionsPageParams = { account_id };
    const params = new URLSearchParams(paramObj);
    router.go(PATH.TRANSACTIONS, { params });
  };

  return {
    onChangeBudgetSelect,
    onChangeNameInput,
    onClickRemove,
    onClickHide,
    onClickAccount,
  };
};
