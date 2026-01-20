import { Account, AccountDictionary, Data } from "common";
import { call, useAppContext } from "client";
import AccountRow from "./AccountRow";
import { AccountType } from "plaid";
import { ReactNode } from "react";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  accountsArray: Account[];
}

export const AccountsTable = ({ accountsArray }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts } = data;

  const depositoryAccounts: ReactNode[] = [];
  const investmentAccounts: ReactNode[] = [];
  const creditAccounts: ReactNode[] = [];
  const otherAccounts: ReactNode[] = [];

  accountsArray.forEach((a) => {
    const element = <AccountRow key={a.account_id} account={a} />;
    switch (a.type) {
      case AccountType.Depository:
        depositoryAccounts.push(element);
        break;
      case AccountType.Investment:
        investmentAccounts.push(element);
        break;
      case AccountType.Credit:
        creditAccounts.push(element);
        break;
      default:
        otherAccounts.push(element);
        break;
    }
  });

  const unhide = async () => {
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
      <div className="rows">
        <div>{depositoryAccounts}</div>
      </div>
      <div className="rows">
        <div>{investmentAccounts}</div>
      </div>
      <div className="rows">
        <div>{creditAccounts}</div>
      </div>
      <div className="rows">
        <div>{otherAccounts}</div>
      </div>
      <div>{!!accountsArray.length && <button onClick={unhide}>Unhide&nbsp;All</button>}</div>
      {!accountsArray.length && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your accounts.
        </div>
      )}
    </div>
  );
};
