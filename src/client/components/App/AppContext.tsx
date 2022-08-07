import { useState, useCallback, ReactNode, Dispatch, SetStateAction } from "react";
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
import { MaskedUser } from "server";

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
  const [user, _setUser] = useState<MaskedUser | undefined>(initialUser);

  const [selectedBudgetId, setSelectedBudgetId] = useLocalStorage<string>(
    "selectedBudgetId",
    ""
  );

  const setUser: Dispatch<SetStateAction<MaskedUser | undefined>> = useCallback(
    (action) => {
      _setUser((oldUser) => {
        const newUser = typeof action === "function" ? action(oldUser) : action;

        const newItems: Items = new Map();
        newUser?.items.forEach((e) => {
          newItems.set(e.item_id, e);
        });
        setItems(newItems);

        return newUser;
      });
    },
    [setItems, _setUser]
  );

  const router = useRouter();

  const contextValue: ContextType = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    institutions,
    setInstitutions,
    items,
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
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
