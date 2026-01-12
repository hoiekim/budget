import { Account, AccountDictionary, Data } from "common";
import { call, useAppContext } from "client";
import AccountRow from "./AccountRow";

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

  const accountRows = accountsArray.map((e, i) => {
    return <AccountRow key={e.account_id} account={e} />;
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
        <div>{accountRows}</div>
      </div>
      <div>{!!accountRows.length && <button onClick={unhide}>Unhide&nbsp;All</button>}</div>
      {!accountRows.length && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your accounts.
        </div>
      )}
    </div>
  );
};
