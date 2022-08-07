import { MaskedUser } from "server";
import { PlaidLinkButton } from "client/components";
import { useAppContext, useSync, call } from "client";
import "./index.css";

const Header = () => {
  const { user, setUser, accounts, setAccounts } = useAppContext();
  const { sync, clean } = useSync();

  const logout = () => {
    call.delete<MaskedUser>("/api/login").then((r) => {
      setUser(r.data);
      clean();
    });
  };

  const unhide = () => {
    return Array.from(accounts.values())
      .filter((e) => e.config?.hide)
      .forEach((e) => {
        const { account_id } = e;
        call.post("/api/account", { account_id, config: { hide: false } }).then((r) => {
          if (r.status === "success") {
            setAccounts((oldAccounts) => {
              const newAccounts = new Map(oldAccounts);
              newAccounts.set(account_id, {
                ...e,
                config: { hide: false },
              });
              return newAccounts;
            });
          }
        });
      });
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
