import { useCallback, useMemo } from "react";
import { Account } from "server";
import { call, useAppContext, useSorter } from "client";
import { PlaidLinkButton } from "client/components";
import ErrorAccountRow, { ErrorAccount } from "./ErrorAccountRow";
import AccountRow from "./AccountRow";
import AccountsHead from "./AccountsHead";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
  budget?: boolean;
  action?: boolean;
};

interface Props {
  errorAccountsArray: ErrorAccount[];
  accountsArray: Account[];
}

const AccountsTable = ({ errorAccountsArray, accountsArray }: Props) => {
  const { accounts, setAccounts, institutions } = useAppContext();

  const sorter = useSorter<Account, AccountHeaders>(
    "accounts",
    new Map([["name", "descending"]]),
    {
      balances: true,
      custom_name: true,
      official_name: true,
      institution: true,
      budget: true,
      action: true,
    }
  );

  const errorAccountRows = errorAccountsArray.map((e, i) => {
    return <ErrorAccountRow key={e.item_id} errorAccount={e} sorter={sorter} />;
  });

  const { sort, visibles, toggleVisible } = sorter;

  const sortedAccountsArray = useMemo(() => {
    return sort([...accountsArray], (e, key) => {
      if (key === "balances") {
        const { available, current } = e.balances;
        return Math.max(available || 0, current || 0);
      } else if (key === "custom_name") {
        return e[key] || e.name;
      } else if (key === "institution") {
        const account = accounts.get(e.account_id);
        return institutions.get(account?.institution_id || "")?.name;
      } else if (key === "budget") {
        const account = accounts.get(e.account_id);
        return institutions.get(account?.institution_id || "")?.name;
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

  const getHeader = useCallback((key: keyof AccountHeaders): string => {
    if (key === "balances") {
      return "Balances";
    } else if (key === "custom_name") {
      return "Name";
    } else if (key === "official_name") {
      return "Official Name";
    } else if (key === "institution") {
      return "Institution";
    } else if (key === "budget") {
      return "Default Budget";
    } else if (key === "action") {
      return "Action";
    } else {
      return key.toString();
    }
  }, []);

  const hiddenColumns = useMemo(() => {
    return Object.entries(visibles)
      .filter(([key, value]) => !value)
      .map(([key, value], i) => {
        return (
          <button
            key={`accounts_hidden_column_${i}`}
            onClick={() => toggleVisible(key as keyof typeof visibles)}
          >
            {getHeader(key as keyof typeof visibles)}
          </button>
        );
      });
  }, [getHeader, toggleVisible, visibles]);

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
      <div>Accounts:</div>
      <div>{hiddenColumns}</div>
      <table>
        <AccountsHead sorter={sorter} getHeader={getHeader} />
        <tbody>
          {errorAccountRows}
          {accountRows}
        </tbody>
      </table>
      <div>
        <PlaidLinkButton>+</PlaidLinkButton>
        <button onClick={unhide}>Unhide</button>
      </div>
    </div>
  );
};

export default AccountsTable;
