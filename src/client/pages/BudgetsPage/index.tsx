import { BudgetsTable } from "client/components";
import "./index.css";

const BudgetsPage = () => {
  return (
    <div className="BudgetsPage">
      <h2>All Budgets</h2>
      <BudgetsTable />
    </div>
  );
};

export default BudgetsPage;
