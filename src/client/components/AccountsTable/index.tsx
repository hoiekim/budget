import { CSSProperties, ReactNode, useState } from "react";
import { AccountType } from "plaid";
import {
  Account,
  AccountDictionary,
  Data,
  call,
  DonutData,
  useAppContext,
  indexedDb,
} from "client";
import AccountRow from "./AccountRow";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  donutData: DonutData[];
  style?: CSSProperties;
}

export const AccountsTable = ({ donutData, style }: Props) => {
  const { data, setData } = useAppContext();
  const { accounts } = data;

  // Archived accounts hidden behind a toggle. Distinct from "Hide" (which
  // removes the account from view entirely + skips it for transfer
  // detection / duplicate-data shadowing). Archived = "I'm done using
  // this account but its history still counts in budget calc."
  const [showArchived, setShowArchived] = useState(false);

  const donutAccounts: ReactNode[] = donutData.map(({ id, color }) => {
    const account = accounts.get(id);
    if (!account) return <></>;
    return <AccountRow key={id} account={account} color={color} />;
  });

  const creditAccounts: ReactNode[] = [];
  const archivedAccounts: ReactNode[] = [];
  let hasHiddenAccounts = false;
  let archivedCount = 0;

  accounts.forEach((a) => {
    if (a.hide) {
      hasHiddenAccounts = true;
      return;
    }
    if (a.archived) {
      archivedCount++;
      archivedAccounts.push(<AccountRow key={a.account_id} account={a} />);
      return;
    }
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
            indexedDb.save(newAccount).catch(console.error);
            newAccounts.set(account_id, newAccount);
          }
        } catch (error: unknown) {
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
    <div className="AccountsTable" style={style}>
      {!!donutAccounts.length && <div className="rows">{donutAccounts}</div>}
      {!!creditAccounts.length && <div className="rows">{creditAccounts}</div>}
      {archivedCount > 0 && (
        <div>
          <button onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"}&nbsp;archived&nbsp;({archivedCount})
          </button>
          {showArchived && <div className="rows">{archivedAccounts}</div>}
        </div>
      )}
      <div>{hasHiddenAccounts && <button onClick={onClickUnhide}>Unhide&nbsp;All</button>}</div>
      {!accounts.size && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your accounts.
        </div>
      )}
    </div>
  );
};

export * from "./Balance";
