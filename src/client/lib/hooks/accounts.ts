import { ChangeEventHandler, Dispatch, SetStateAction, useMemo, useState } from "react";
import {
  Account,
  AccountDictionary,
  AccountGraphOptions,
  AccountSnapshot,
  Data,
  InvestmentTransaction,
  Transaction,
  ViewDate,
} from "common";
import { GraphInput, PATH, TransactionsPageParams, call, useAppContext } from "client";

export const useAccountGraph = (accounts: Account[], options = new AccountGraphOptions()) => {
  const { data, viewDate } = useAppContext();
  const { useSnapshots = true, useTransactions = true } = options;

  const graphViewDate = useMemo(() => {
    const isFuture = new Date() < viewDate.getEndDate();
    return isFuture ? viewDate : new ViewDate(viewDate.getInterval());
  }, [viewDate]);

  const { graphData, cursorAmount } = useMemo(() => {
    const {
      accounts: accountsDictionary,
      transactions,
      investmentTransactions,
      accountSnapshots,
    } = data;

    const validAccounts = accounts.filter((a) => a.type !== "credit");
    const accountIds = validAccounts.map((a) => a.account_id);
    const totalBalance = validAccounts.reduce((acc, a) => acc + (a.balances.current || 0), 0);
    const balanceHistory: number[] = [totalBalance || 0];

    const translate = (transaction: Transaction | InvestmentTransaction) => {
      const authorized_date =
        "authorized_date" in transaction ? transaction.authorized_date : undefined;
      const { date, amount } = transaction;
      if (!accountIds.includes(transaction.account_id)) return;
      const transactionDate = new Date(authorized_date || date);
      const span = graphViewDate.getSpanFrom(transactionDate) + 1;
      if (!balanceHistory[span]) balanceHistory[span] = 0;
      const account = accountsDictionary.get(transaction.account_id);
      if (account && account.type === "investment") {
        const { price, quantity } = transaction as InvestmentTransaction;
        balanceHistory[span] -= price * quantity;
      } else {
        balanceHistory[span] += amount;
      }
    };

    transactions.forEach(translate);
    investmentTransactions.forEach(translate);

    const { length } = balanceHistory;

    if (length < 2) return { graphData: {} as GraphInput };

    const lengthFixer = 3 - ((length - 1) % 3);

    for (let i = 1; i < length; i++) {
      if (!balanceHistory[i] || !useTransactions) balanceHistory[i] = 0;
      balanceHistory[i] += balanceHistory[i - 1];
    }

    balanceHistory.push(...new Array(lengthFixer));

    const nowSnapshot: { [account_id: string]: AccountSnapshot } = {};
    accounts.forEach((a) => {
      nowSnapshot[a.id] = new AccountSnapshot({ account: a });
    });
    const snapshotHistory: { [account_id: string]: AccountSnapshot }[] = [nowSnapshot];

    if (useSnapshots) {
      accountSnapshots.forEach((as) => {
        const { snapshot, account } = as;
        const { date } = snapshot;
        if (!account.balances.current) return;
        if (!accountIds.includes(account.account_id)) return;
        const span = graphViewDate.getSpanFrom(new Date(date)) + 1;
        const existing = snapshotHistory[span];
        if (existing) {
          if (existing[account.id] && existing[account.id].snapshot.date < date) {
            existing[account.id] = as;
          }
        } else {
          snapshotHistory[span] = { [account.id]: as };
        }
      });

      if (useTransactions) {
        snapshotHistory.forEach((snapshotDict, span) => {
          if (!snapshotDict) return;
          const snapshots = Object.values(snapshotDict);
          if (snapshots.length !== accountIds.length) return;
          let totalBalance = 0;
          snapshots.forEach(({ account }) => {
            totalBalance += account.balances.current || 0;
          });
          balanceHistory[span] = totalBalance;
        });
      } else {
        const snapshots = Object.values(snapshotHistory[snapshotHistory.length - 1]);
        let totalBalance = 0;
        snapshots.forEach(({ account }) => {
          totalBalance += account.balances.current || 0;
        });
        balanceHistory[balanceHistory.length - 1] = totalBalance;
        for (let i = balanceHistory.length - 2; i >= 0; i--) {
          const snapshotDict = snapshotHistory[i];
          if (snapshotDict) {
            const snapshots = Object.values(snapshotDict);
            let totalBalance = 0;
            snapshots.forEach(({ account }) => {
              totalBalance += account.balances.current || 0;
            });
            balanceHistory[i] = totalBalance;
          } else {
            balanceHistory[i] = balanceHistory[i + 1];
          }
        }
      }
    }

    const sequence = balanceHistory.reverse();

    const todayIndex = graphViewDate.getSpanFrom(viewDate.getEndDate()) - lengthFixer + 1;
    const pointIndex = length - todayIndex;
    const pointValue = balanceHistory[pointIndex];
    const points = [];
    if (pointValue !== undefined) {
      points.push({ point: { value: pointValue, index: pointIndex }, color: "#097" });
    }

    const graphData: GraphInput = { lines: [{ sequence, color: "#097" }], points };

    return { graphData, cursorAmount: pointValue };
  }, [data, accounts, graphViewDate, viewDate]);

  return { graphViewDate, graphData, cursorAmount };
};

export const useAccountEventHandlers = (account: Account) => {
  const { account_id, custom_name, label, hide, graphOptions } = account;

  const { setData, router } = useAppContext();

  const [nameInput, setNameInput] = useState(custom_name || "");

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(() => {
    return label.budget_id || "";
  });

  const [isHidden, setIsHidden] = useState(hide);
  const [useTransactionsForGraph, setUseTransactionsForGraph] = useState(
    graphOptions?.useTransactions
  );
  const [useSnapshotsForGraph, setUseSnapshotsForGraph] = useState(graphOptions?.useSnapshots);

  const onChangeNameInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    const { value } = e.target;
    if (value === nameInput) return;
    setNameInput(value);
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
  };

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

  const onClickHide: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    setIsHidden(checked);
    if (!account_id) return;
    call.post("/api/account", { account_id, hide: checked }).then((r) => {
      if (r.status === "success") {
        setData((oldData) => {
          const newData = new Data(oldData);
          const existingAccount = newData.accounts.get(account_id);
          if (!existingAccount) return oldData;
          const newAccount = new Account({ ...existingAccount, hide: checked });
          const newAccounts = new AccountDictionary(newData.accounts);
          newAccounts.set(account_id, newAccount);
          newData.accounts = newAccounts;
          return newData;
        });
      }
    });
  };

  const onClickUseTransactionsForGraph: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    setUseTransactionsForGraph(checked);
    if (!account_id) return;
    call
      .post("/api/account", {
        account_id,
        graphOptions: { useTransactions: checked },
      })
      .then((r) => {
        if (r.status === "success") {
          setData((oldData) => {
            const newData = new Data(oldData);
            const existingAccount = newData.accounts.get(account_id);
            if (!existingAccount) return oldData;
            const newGraphOptions = new AccountGraphOptions(existingAccount.graphOptions);
            newGraphOptions.useTransactions = checked;
            const newAccount = new Account({
              ...existingAccount,
              graphOptions: newGraphOptions,
            });
            const newAccounts = new AccountDictionary(newData.accounts);
            newAccounts.set(account_id, newAccount);
            newData.accounts = newAccounts;
            return newData;
          });
        }
      });
  };

  const onClickUseSnapshotsForGraph: ChangeEventHandler<HTMLInputElement> = (e) => {
    e.stopPropagation();
    const { checked } = e.target;
    setUseSnapshotsForGraph(checked);
    if (!account_id) return;
    call
      .post("/api/account", {
        account_id,
        graphOptions: { useSnapshots: checked },
      })
      .then((r) => {
        if (r.status === "success") {
          setData((oldData) => {
            const newData = new Data(oldData);
            const existingAccount = newData.accounts.get(account_id);
            if (!existingAccount) return oldData;
            const newGraphOptions = new AccountGraphOptions(existingAccount.graphOptions);
            newGraphOptions.useSnapshots = checked;
            const newAccount = new Account({
              ...existingAccount,
              graphOptions: newGraphOptions,
            });
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
    nameInput,
    onChangeNameInput,
    selectedBudgetIdLabel,
    onChangeBudgetSelect,
    isHidden,
    onClickHide,
    useTransactionsForGraph,
    onClickUseTransactionsForGraph,
    useSnapshotsForGraph,
    onClickUseSnapshotsForGraph,
    onClickAccount,
  };
};
