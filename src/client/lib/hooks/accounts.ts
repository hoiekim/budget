import { ChangeEventHandler, MouseEventHandler, useEffect, useMemo, useState } from "react";
import {
  Account,
  AccountDictionary,
  AccountGraphOptions,
  AccountSnapshot,
  AccountSnapshotDictionary,
  Data,
  InvestmentTransaction,
  ItemProvider,
  numberToCommaString,
  Snapshot,
  Transaction,
  TransactionDictionary,
  ViewDate,
} from "common";
import { GraphInput, call, useAppContext, useDebounce } from "client";
import { SnapshotPostResponse } from "server/routes/accounts/post-snapshot";
import { AccountType } from "plaid";
import { AccountPostResponse } from "server";

export const useAccountGraph = (accounts: Account[], options = new AccountGraphOptions()) => {
  const { data, viewDate } = useAppContext();

  const graphViewDate = useMemo(() => {
    const isFuture = new Date() < viewDate.getEndDate();
    return isFuture ? viewDate : new ViewDate(viewDate.getInterval());
  }, [viewDate]);

  const {
    accounts: accountsDictionary,
    transactions,
    investmentTransactions,
    accountSnapshots,
  } = data;

  const { graphData, cursorAmount } = useMemo(() => {
    const { useSnapshots, useTransactions } = options;

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

    for (let i = 1; i < balanceHistory.length; i++) {
      if (!balanceHistory[i] || !useTransactions) balanceHistory[i] = 0;
      balanceHistory[i] += balanceHistory[i - 1];
    }

    const nowSnapshot: { [account_id: string]: AccountSnapshot } = {};
    accounts.forEach((a) => {
      nowSnapshot[a.id] = new AccountSnapshot({ account: a });
    });

    if (useSnapshots) {
      const snapshotHistory: { [account_id: string]: AccountSnapshot }[] = [nowSnapshot];

      accountSnapshots.forEach((as) => {
        const { snapshot, account } = as;
        const { date } = snapshot;
        if (!account.balances.current && account.balances.current !== 0) return;
        if (!accountIds.includes(account.account_id)) return;
        const span = graphViewDate.getSpanFrom(new Date(date));
        const existing = snapshotHistory[span];
        if (existing) {
          if (!existing[account.id] || existing[account.id]?.snapshot.date < date) {
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
        const longestSpan = Math.max(snapshotHistory.length, balanceHistory.length) - 1;
        balanceHistory[longestSpan] = totalBalance;
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

    const { length } = balanceHistory;

    const lengthFixer = 3 - ((length - 1) % 3);

    balanceHistory.push(...new Array(lengthFixer));

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
  }, [
    accounts,
    accountsDictionary,
    transactions,
    investmentTransactions,
    accountSnapshots,
    options,
    graphViewDate,
    viewDate,
  ]);

  return { graphViewDate, graphData, cursorAmount };
};

export const useAccountEventHandlers = (account: Account, cursorAmount?: number) => {
  const { account_id, custom_name, type, label, hide, graphOptions, balances } = account;

  const { data, setData, viewDate, router } = useAppContext();

  const { items } = data;
  const item = items.get(account.item_id);
  const isManualAccount = item?.provider === ItemProvider.MANUAL;

  const [nameInput, setNameInput] = useState(custom_name || "");

  const [typeInput, setTypeInput] = useState(type);

  const [balanceSnapshotInput, setBalanceSnapshotInput] = useState("");

  useEffect(() => {
    const newDefaultBalanceSnapshotAmount =
      "$ " + numberToCommaString(cursorAmount || balances.current || 0, 2);
    setBalanceSnapshotInput((old) => {
      if (old !== newDefaultBalanceSnapshotAmount) {
        return newDefaultBalanceSnapshotAmount;
      }
      return old;
    });
  }, [cursorAmount, balances]);

  const [selectedBudgetIdLabel, setSelectedBudgetIdLabel] = useState(label.budget_id || "");

  const [isHidden, setIsHidden] = useState(hide);
  const [useTransactionsForGraph, setUseTransactionsForGraph] = useState(
    graphOptions?.useTransactions
  );
  const [useSnapshotsForGraph, setUseSnapshotsForGraph] = useState(graphOptions?.useSnapshots);

  const debouncer = useDebounce();

  const onChangeNameInput: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const { value } = e.target;
    if (value === nameInput) return;
    setNameInput(value);

    debouncer(async () => {
      const r = await call.post("/api/account", {
        account_id,
        custom_name: value,
      });

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
      } else {
        setNameInput(nameInput);
      }
    }, 300);
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
        const existingAccount = newData.accounts.get(account_id);
        if (!existingAccount) return oldData;
        const newAccount = new Account({ ...existingAccount, label: { budget_id: value || null } });
        const newAccounts = new AccountDictionary(newData.accounts);
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

  const onChangeBalanceSnapshotInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    const todayViewDate = new ViewDate(viewDate.getInterval());
    const isTargetingCurrent = viewDate.getEndDate() >= todayViewDate.getEndDate();
    if (!isManualAccount && isTargetingCurrent) return;

    debouncer(async () => {
      const { value } = e.target;
      const numericValue = parseFloat(value.replace(/$,/g, ""));
      if (isNaN(numericValue)) return;
      const newAccount = new Account({
        ...account,
        balances: { ...account.balances, current: numericValue },
      });
      const date = viewDate.getEndDate().toISOString();
      if (isTargetingCurrent) {
        const response = await call.post<AccountPostResponse>("/api/account", {
          account_id,
          balances: { current: numericValue },
        });
        if (response.status === "success") {
          setData((oldData) => {
            const newData = new Data(oldData);
            const newAccounts = new AccountDictionary(newData.accounts);
            newAccounts.set(account_id, newAccount);
            newData.accounts = newAccounts;
            return newData;
          });
        }
      } else {
        const response = await call.post<SnapshotPostResponse>("/api/snapshot", {
          account: newAccount,
          snapshot: { date },
        });
        const snapshot_id = response.body?.snapshot_id;
        if (response.status === "success" && snapshot_id) {
          setData((oldData) => {
            const newData = new Data(oldData);
            const newAccountSnapshot = new AccountSnapshot({
              snapshot: new Snapshot({ snapshot_id, date }),
              account: newAccount,
            });
            const newAccountSnapshots = new AccountSnapshotDictionary(newData.accountSnapshots);
            newAccountSnapshots.set(snapshot_id, newAccountSnapshot);
            newData.accountSnapshots = newAccountSnapshots;
            return newData;
          });
        }
      }
    }, 300);
  };

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();

    const confirmed = window.confirm("Do you want to delete this account?");

    if (confirmed) {
      call.delete(`/api/account?id=${account_id}`).then((r) => {
        if (r.status === "success") {
          setData((oldData) => {
            const newData = new Data(oldData);
            const newAccounts = new AccountDictionary(newData.accounts);
            newAccounts.delete(account_id);
            newData.accounts = newAccounts;

            const newTransactions = new TransactionDictionary(newData.transactions);
            newTransactions.forEach((e) => {
              if (e.account_id === account_id) {
                newTransactions.delete(e.transaction_id);
              }
            });
            newData.transactions = newTransactions;

            const newAccountSnapshots = new AccountSnapshotDictionary(newData.accountSnapshots);
            newAccountSnapshots.forEach((e) => {
              if (e.account.account_id === account_id) {
                newAccountSnapshots.delete(e.snapshot.snapshot_id);
              }
            });
            newData.accountSnapshots = newAccountSnapshots;

            return newData;
          });

          router.back();
        }
      });
    }
  };

  const onChangeTypeInput: ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const { value } = e.target;
    if (value === selectedBudgetIdLabel) return;
    if (!isAccountType(value)) return;

    setTypeInput(value);

    const r = await call.post("/api/account", { account_id, type: value });

    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const existingAccount = newData.accounts.get(account_id);
        if (!existingAccount) return oldData;
        const newAccount = new Account({ ...existingAccount, type: value });
        const newAccounts = new AccountDictionary(newData.accounts);
        newAccounts.set(account_id, newAccount);
        newData.accounts = newAccounts;
        return newData;
      });
    } else {
      setTypeInput(typeInput);
    }
  };

  return {
    nameInput,
    onChangeNameInput,
    typeInput,
    onChangeTypeInput,
    selectedBudgetIdLabel,
    onChangeBudgetSelect,
    isHidden,
    onClickHide,
    useTransactionsForGraph,
    onClickUseTransactionsForGraph,
    useSnapshotsForGraph,
    onClickUseSnapshotsForGraph,
    balanceSnapshotInput,
    setBalanceSnapshotInput,
    onChangeBalanceSnapshotInput,
    onClickRemove,
  };
};

const isAccountType = (value: any): value is AccountType => {
  return Object.values(AccountType).includes(value);
};
