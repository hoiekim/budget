import {
  Header,
  TransactionsTable,
  AccountsTable,
  BudgetsTable,
} from "client/components";

const Home = () => {
  return (
    <div className="Home">
      <Header />
      <div className="row-spacer" />
      <BudgetsTable />
      <div className="row-spacer" />
      <AccountsTable />
      <div className="row-spacer" />
      <TransactionsTable />
    </div>
  );
};

export default Home;
