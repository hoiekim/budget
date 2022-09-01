import { useState, ReactNode } from "react";
import {
  useLocalStorage,
  ContextType,
  Context,
  useRouter,
  Transactions,
  Accounts,
  Institutions,
  Items,
  Budgets,
  Sections,
  Categories,
} from "client";
import { MaskedUser, Interval } from "server";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const [transactions, setTransactions] = useState<Transactions>(new Map());
  const [accounts, setAccounts] = useState<Accounts>(new Map());
  const [items, setItems] = useState<Items>(new Map());
  const [institutions, setInstitutions] = useLocalStorage<Institutions>(
    "map_institutions",
    new Map()
  );
  const [budgets, setBudgets] = useState<Budgets>(new Map());
  const [sections, setSections] = useState<Sections>(new Map());
  const [categories, setCategories] = useState<Categories>(new Map());
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);

  const [selectedBudgetId, setSelectedBudgetId] = useLocalStorage("selectedBudgetId", "");
  const [selectedInterval, setSelectedInterval] = useLocalStorage<Interval>(
    "selectedInterval",
    "month"
  );
  const [viewDate, setViewDate] = useState<Date>(new Date());

  const router = useRouter();

  const contextValue: ContextType = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    institutions,
    setInstitutions,
    items,
    setItems,
    user,
    setUser,
    router,
    budgets,
    setBudgets,
    sections,
    setSections,
    categories,
    setCategories,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
    setSelectedInterval,
    viewDate,
    setViewDate,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
