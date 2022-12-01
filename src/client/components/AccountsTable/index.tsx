import { useMemo } from "react";
import { Account } from "server";
import { call, useAppContext, useSorter } from "client";
import { PlaidLinkButton } from "client/components";
import AccountRow from "./AccountRow";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  accountsArray: Account[];
}

const AccountsTable = ({ accountsArray }: Props) => {
  const { accounts, setAccounts, institutions } = useAppContext();

  const sorter = useSorter<Account, AccountHeaders>(
    "accounts",
    new Map([["name", "descending"]]),
    {
      balances: true,
      custom_name: true,
      institution: true,
      budget: true,
      action: true,
    }
  );

  const { sort } = sorter;

  const sortedAccountsArray = useMemo(() => {
    return sort([...accountsArray], (e, key) => {
      if (key === "balances") {
        const { available, current } = e.balances;
        return Math.max(available || 0, current || 0);
      } else if (key === "custom_name") {
        return e[key] || e.name || "";
      } else if (key === "institution") {
        const account = accounts.get(e.account_id);
        return institutions.get(account?.institution_id || "")?.name || "";
      } else if (key === "budget") {
        const account = accounts.get(e.account_id);
        return institutions.get(account?.institution_id || "")?.name || "";
      } else if (key === "action") {
        return 0;
      } else {
        return e[key];
      }
    });
  }, [accountsArray, accounts, institutions, sort]);

  const accountRows = sortedAccountsArray.map((e, i) => {
    return <AccountRow key={e.account_id} account={e} sorter={sorter} />;
  });

  const unhide = async () => {
    const newAccounts = new Map(accounts);

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
            e.hide = false;
            newAccounts.set(account_id, e);
          }
        } catch (error: any) {
          console.error(error);
        }
      };

      fetchJobs.push(job(account));
    });

    await Promise.all(fetchJobs);
    setAccounts(newAccounts);
  };

  return (
    <div className="AccountsTable">
      <div className="rows">
        <div>{accountRows}</div>
      </div>
      <div>
        <PlaidLinkButton>+</PlaidLinkButton>
        {!!accountRows.length && <button onClick={unhide}>Unhide</button>}
      </div>
      {!accountRows.length && (
        <div className="placeholder">
          You don't have any connected accounts! Click this button to connect your
          accounts.
        </div>
      )}
    </div>
  );
};

export default AccountsTable;
