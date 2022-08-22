import { useAppContext, useSync, call } from "client";
import { PlaidLinkButton } from "client/components";
import "./index.css";

const Header = () => {
  const { user, setUser, accounts, setAccounts, router } = useAppContext();
  const { sync, clean } = useSync();
  const { path, go } = router;

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
      {user && (
        <>
          <div>
            <span>{user?.username}</span>
          </div>
          <div>
            <button disabled={path === "/"} onClick={() => go("/")}>
              Home
            </button>
          </div>
          <div>
            <button disabled={path === "/status"} onClick={() => go("/status")}>
              Status
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default Header;
