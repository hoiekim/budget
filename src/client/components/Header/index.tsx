import { useAppContext, useSync, call } from "client";
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

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div>
        <div>
          <button disabled={!user} onClick={logout}>
            Logout
          </button>
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
      </div>
    </div>
  );
};

export default Header;
