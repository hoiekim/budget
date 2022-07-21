import { MaskedUser } from "server";
import { PlaidLinkButton, SyncButton } from "client/components";
import { useAppContext, useSync, call } from "client";
import "./index.css";

const Header = () => {
  const { user, setUser } = useAppContext();
  const { clean } = useSync();

  const onClick = () => {
    call.delete<MaskedUser>("/api/login").then((r) => {
      setUser(r.data);
      clean();
    });
  };

  return (
    <div className="Header">
      <div>
        <span>{user?.username} is logged in</span>
        <button onClick={onClick}>Logout</button>
      </div>
      <PlaidLinkButton>Connect a Bank Account</PlaidLinkButton>
      <SyncButton />
    </div>
  );
};

export default Header;
