import {
  ChangeEventHandler,
  Dispatch,
  MouseEventHandler,
  SetStateAction,
  useMemo,
  useRef,
} from "react";
import {
  Account,
  AccountDictionary,
  Data,
  InvestmentTransaction,
  Timeout,
  Transaction,
  TransactionDictionary,
  ViewDate,
} from "common";
import { GraphInput, PATH, TransactionsPageParams, call, useAppContext } from "client";

export const useGraph = (account: Account) => {
  const {
    account_id,
    type,
    balances: { current },
  } = account;

  const { data, viewDate } = useAppContext();
  const { transactions, investmentTransactions } = data;

  const graphViewDate = useMemo(() => {
    const isFuture = new Date() < viewDate.getDate();
    return isFuture ? viewDate : new ViewDate(viewDate.getInterval());
  }, [viewDate]);

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

    const todayIndex = graphViewDate.getSpanFrom(viewDate.getDate()) - lengthFixer + 1;
    const pointIndex = length - todayIndex;
    const pointValue = balanceHistory[pointIndex];
    const points = [];
    if (pointValue !== undefined) {
      points.push({ point: { value: pointValue, index: pointIndex }, color: "#097" });
    }

    return { lines: [{ sequence, color: "#097" }], points };
  }, [
    transactions,
    current,
    account_id,
    type,
    investmentTransactions,
    graphViewDate,
    viewDate,
  ]);

  return { graphViewDate, graphData };
};

export const useEventHandlers = (
  account: Account,
  selectedBudgetIdLabel: string,
  setSelectedBudgetIdLabel: Dispatch<SetStateAction<string>>,
  setNameInput: Dispatch<SetStateAction<string>>
) => {
  const { account_id } = account;

  const { data, setData, user, router } = useAppContext();
  const { items, institutions } = data;

  const onChangeBudgetSelect: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;

    setSelectedBudgetIdLabel(value || "");

    const r = await call.post("/api/account", {
      account_id,
      label: { budget_id: value || null },
    });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newAccount = new Account(account);
        const newAccounts = new AccountDictionary(newData.accounts);
        newAccount.label.budget_id = value || null;
        newAccounts.set(account_id, newAccount);
        newData.accounts = newAccounts;
        return newData;
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
          setData((oldData) => {
            const newData = new Data(oldData);
            const existingAccount = newData.accounts.get(account_id);
            if (!existingAccount) return oldData;
            const newAccount = new Account({ ...existingAccount, custom_name: value });
            const newAccounts = new AccountDictionary(newData.accounts);
            newAccounts.set(account_id, newAccount);
            newData.accounts = newAccounts;
            return newData;
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

        setData((oldData) => {
          const newData = new Data(oldData);

          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.forEach((e) => {
            if (e.item_id === item_id) accountsInItem.push(e);
          });
          accountsInItem.forEach((e) => {
            newAccounts.delete(e.account_id);
          });
          newData.accounts = newAccounts;

          const newTransactions = new TransactionDictionary(newData.transactions);
          newTransactions.forEach((e) => {
            if (accountsInItem.find((f) => e.account_id === f.account_id)) {
              newTransactions.delete(e.transaction_id);
            }
          });
          newData.transactions = newTransactions;
          return newData;
        });
      });
    }
  };

  const onClickHide: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (!account_id) return;
    call.post("/api/account", { account_id, hide: true }).then((r) => {
      if (r.status === "success") {
        setData((oldData) => {
          const newData = new Data(oldData);
          const existingAccount = newData.accounts.get(account_id);
          if (!existingAccount) return oldData;
          const newAccount = new Account({ ...existingAccount, hide: true });
          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.set(account_id, newAccount);
          newData.accounts = newAccounts;
          return newData;
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
