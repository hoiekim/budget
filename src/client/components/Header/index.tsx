import { MaskedUser } from "server";
import { PlaidLinkButton } from "client/components";
import { useAppContext, useSync, call } from "client";
import "./index.css";
import { useCallback, useMemo } from "react";

const Header = () => {
  const { user, setUser, accounts, setAccounts } = useAppContext();
  const { sync, clean } = useSync();

  const logout = useCallback(() => {
    call.delete<MaskedUser>("/api/login").then((r) => {
      setUser(r.data);
      clean();
    });
  }, [setUser, clean]);

  const unhide = useCallback(async () => {
    const newAccounts = new Map(accounts);

    const fetchJobs = Array.from(accounts.values())
      .filter((e) => e.config?.hide)
      .map(async (e) => {
        try {
          const { account_id } = e;
          const r = await call.post("/api/account", {
            account_id,
            config: { hide: false },
          });

          if (r.status === "success") {
            newAccounts.set(account_id, {
              ...e,
              config: { hide: false },
            });
          }
        } catch (error: any) {
          console.error(error);
        }
      });

    await Promise.all(fetchJobs);
    setAccounts(newAccounts);
  }, [accounts, setAccounts]);

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
