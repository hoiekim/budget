import { Account, AccountDictionary, Data } from "common";
import { call, DonutData, useAppContext } from "client";
import AccountRow from "./AccountRow";
import { AccountType } from "plaid";
import { ReactNode } from "react";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  donutData: DonutData[];
}

export const AccountsTable = ({ donutData }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts } = data;

  const donutAccounts: ReactNode[] = donutData.map(({ id, color }) => {
    const account = accounts.get(id);
    if (!account) return <></>;
    return <AccountRow key={id} account={account} color={color} />;
  });

  const creditAccounts: ReactNode[] = [];

  accounts.forEach((a) => {
    const element = <AccountRow key={a.account_id} account={a} />;
    if (a.type === AccountType.Credit) creditAccounts.push(element);
  });

  const onClickUnhide = async () => {
    const newAccounts = new AccountDictionary(accounts);

    const fetchJobs: Promise<void>[] = [];
    accounts.forEach((account) => {
      if (!account.hide) return;

      const job = async (e: typeof account) => {
        try {
          const { account_id } = e;
          const r = await call.post("/api/account", {
            account_id,
            hide: false,
          });

          if (r.status === "success") {
            const newAccount = new Account({ ...e, hide: false });
            newAccounts.set(account_id, newAccount);
          }
        } catch (error: any) {
          console.error(error);
        }
      };

      fetchJobs.push(job(account));
    });

    await Promise.all(fetchJobs);
    setData((oldData) => {
      const newData = new Data(oldData);
      newData.accounts = newAccounts;
      return newData;
    });
  };

  return (
    <div className="AccountsTable">
      {!!donutAccounts.length && (
        <div className="rows">
          <div>{donutAccounts}</div>
        </div>
      )}
      {!!creditAccounts.length && (
        <div className="rows">
          <div>{creditAccounts}</div>
        </div>
      )}
      <div>{!!accounts.size && <button onClick={onClickUnhide}>Unhide&nbsp;All</button>}</div>
      {!accounts.size && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your accounts.
        </div>
      )}
    </div>
  );
};
