import {
  LoginInterface,
  PlaidLinkButton,
  SyncButton,
  TransactionsTable,
  AccountsTable,
} from "client/components";

const Home = () => {
  return (
    <div className="Home">
      <LoginInterface />
      <PlaidLinkButton />
      <SyncButton />
      <AccountsTable />
      <TransactionsTable />
    </div>
  );
};

export default Home;
