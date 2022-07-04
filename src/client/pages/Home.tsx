import { MaskedUser } from "server";
import {
  PlaidLinkButton,
  SyncButton,
  TransactionsTable,
  AccountsTable,
} from "client/components";
import { useAppContext, useSync, call } from "client";

const Home = () => {
  const { user, setUser } = useAppContext();
  const { clean } = useSync();

  const onClick = () => {
    call.delete<MaskedUser>("/api/login").then((r) => {
      setUser(r.data);
      clean();
    });
  };
  return (
    <div className="Home">
      <div>{user?.username} is logged in</div>
      <div>
        <button onClick={onClick}>Logout</button>
      </div>
      <PlaidLinkButton />
      <SyncButton />
      <AccountsTable />
      <TransactionsTable />
    </div>
  );
};

export default Home;
