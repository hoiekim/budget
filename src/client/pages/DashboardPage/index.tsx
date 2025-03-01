import { useMemo } from "react";
import { useAppContext } from "client";
import { AccountsDonut, AccountsTable } from "client/components";
import { Account } from "common";
import "./index.css";

export const DashboardPage = () => {
  const { user, data } = useAppContext();
  const { items, accounts } = data;

  return (
    <div className="DashboardPage">
      <h2>Dashboard</h2>
    </div>
  );
};
