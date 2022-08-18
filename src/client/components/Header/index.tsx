import { useAppContext, useSync, call } from "client";
import { PlaidLinkButton } from "client/components";
import "./index.css";

const Header = () => {
  const { user, setUser, accounts, setAccounts } = useAppContext();
  const { sync, clean } = useSync();

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

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
    <div className="Header">
      <div>
        <span>{user?.username} is logged in</span>
        <button onClick={logout}>Logout</button>
      </div>
      <div>
        <PlaidLinkButton>Connect a Bank Account</PlaidLinkButton>
      </div>
      <div>
        <button onClick={unhide}>Unhide Accounts</button>
      </div>
      <div>
        <button onClick={sync.all}>Sync Data</button>
      </div>
    </div>
  );
};

export default Header;
