import { Account } from "server";
import { call, useAppContext } from "client";
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
  const { accounts, setAccounts } = useAppContext();

  const accountRows = accountsArray.map((e, i) => {
    return <AccountRow key={e.account_id} account={e} />;
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
