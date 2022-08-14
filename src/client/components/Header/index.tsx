import { useCallback } from "react";
import { MaskedUser } from "server";
import { useAppContext, useSync, call } from "client";
import { PlaidLinkButton } from "client/components";
import "./index.css";

const Header = () => {
  const { user, setUser, accounts, setAccounts, selectedBudgetId } = useAppContext();
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
      .filter((e) => e.labels)
      .map(async (e) => {
        try {
          const updatedLabel = { budget_id: selectedBudgetId, hide: false };
          const { account_id } = e;
          const r = await call.post("/api/account-label", {
            account_id,
            label: updatedLabel,
          });

          if (r.status === "success") {
            const { labels } = e;
            labels.find((f, j) => {
              if (f.budget_id === selectedBudgetId) {
                labels.splice(j, 1);
                return true;
              }
              return false;
            });
            labels.push(updatedLabel);
            newAccounts.set(account_id, e);
          }
        } catch (error: any) {
          console.error(error);
        }
      });

    await Promise.all(fetchJobs);
    setAccounts(newAccounts);
  }, [accounts, setAccounts, selectedBudgetId]);

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
