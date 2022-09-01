import { useAppContext, useSync, call } from "client";
import { ReactNode } from "react";
import "./index.css";

const Header = () => {
  const { user, setUser, router } = useAppContext();
  const { clean } = useSync();
  const { path, go } = router;

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

  type NavigatorProps = { target: string; children: ReactNode };
  const Navigator = ({ target, children }: NavigatorProps) => (
    <button disabled={path === target} onClick={() => go(target)}>
      {children}
    </button>
  );

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div>
        <div>
          <button disabled={!user} onClick={logout}>
            Logout
          </button>
        </div>
        <div>
          <Navigator target="/">Home</Navigator>
        </div>
        <div>
          <Navigator target="/budgets">Budgets</Navigator>
        </div>
        <div>
          <Navigator target="/accounts">Accounts</Navigator>
        </div>
        <div>
          <Navigator target="/transactions">Transactions</Navigator>
        </div>
      </div>
    </div>
  );
};

export default Header;
