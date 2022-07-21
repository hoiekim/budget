import { Account } from "server";
import { useAppContext, useSorter } from "client";
import AccountRow, { ErrorAccount } from "./AccountRow";
import AccountsHead from "./AccountsHead";

export type AccountHeaders = { [k in keyof Account]?: boolean } & {
  institution?: boolean;
};

const AccountsTable = () => {
  const { user, accounts, institutions } = useAppContext();

  const sorter = useSorter<Account, AccountHeaders>(
    "accounts",
    new Map([["name", "descending"]]),
    {
      balances: true,
      name: true,
      institution: true,
    }
  );

  const { sort, visibles, toggleVisible } = sorter;

  const accountsArray: (Account | ErrorAccount)[] = sort(
    Array.from(accounts.values()),
    (e, key) => {
      if (key === "balances") {
        return Math.max(e.available, e.current);
      } else if (key === "institution") {
        const account = accounts.get(e.account_id);
        return institutions.get(account?.institution_id || "")?.name;
      } else {
        return e[key];
      }
    }
  );

  const accountsAndErrorAccounts = accountsArray.concat(
    user?.items
      ?.filter((e) => e.plaidError)
      .map((e) => {
        const { institution_id, item_id } = e;
        return { institution_id, item_id };
      }) || []
  );

  const accountRows = accountsAndErrorAccounts.map((e, i) => {
    return <AccountRow key={i} account={e} sorter={sorter} />;
  });

  const getHeader = (key: keyof AccountHeaders): string => {
    if (key === "balances") {
      return "Balances";
    } else if (key === "name") {
      return "Name";
    } else if (key === "institution") {
      return "Institution";
    } else {
      return key.toString();
    }
  };

  const hiddenColumns = Object.entries(visibles)
    .filter(([key, value]) => !value)
    .map(([key, value], i) => {
      return (
        <button key={i} onClick={() => toggleVisible(key as keyof typeof visibles)}>
          {getHeader(key as keyof typeof visibles)}
        </button>
      );
    });

  return (
    <div className="AccountsTable">
      <div>Accounts:</div>
      <div>{hiddenColumns}</div>
      <table>
        <AccountsHead sorter={sorter} getHeader={getHeader} />
        <tbody>{accountRows}</tbody>
      </table>
    </div>
  );
};

export default AccountsTable;
