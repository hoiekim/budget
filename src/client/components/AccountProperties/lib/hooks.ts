import { call, useAppContext, useDebounce } from "client";
import {
  Account,
  AccountDictionary,
  AccountGraphOptions,
  AccountSnapshot,
  AccountSnapshotDictionary,
  Data,
  ItemProvider,
  numberToCommaString,
  Snapshot,
  TransactionDictionary,
  ViewDate,
} from "common";
import { AccountType } from "plaid";
import { ChangeEventHandler, MouseEventHandler, useEffect, useState } from "react";
import { AccountPostResponse, SnapshotPostResponse } from "server";

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
