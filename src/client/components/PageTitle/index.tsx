import { ReactNode } from "react";
import "./index.css";

interface Props {
  children: ReactNode;
}

/**
 * Sticky page-level `<h2>` heading used at the top of list pages
 * (AccountsPage, BudgetsPage, DashboardPage, etc.). Provides the shared
 * sticky/padding/z-index styling that every list page's own CSS used to
 * declare identically.
 */
export const PageTitle = ({ children }: Props) => <h2 className="PageTitle">{children}</h2>;
