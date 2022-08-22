import {
  useState,
  useCallback,
  ReactNode,
  Dispatch,
  SetStateAction,
  useEffect,
} from "react";
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
  IsNow,
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
  const [user, _setUser] = useState<MaskedUser | undefined>(initialUser);

  const [selectedBudgetId, setSelectedBudgetId] = useLocalStorage("selectedBudgetId", "");
  const [selectedInterval, setSelectedInterval] = useLocalStorage<Interval>(
    "selectedInterval",
    "month"
  );

  useEffect(() => {
    const budget = budgets.get(selectedBudgetId);
    if (!budget) return;

    const isNow = new IsNow();

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      newCategories.forEach((e) => {
        e.amount = 0;
      });
      transactions.forEach((e) => {
        const transactionDate = new Date(e.authorized_date || e.date);
        if (!isNow.within(selectedInterval).from(transactionDate)) return;
        const account = accounts.get(e.account_id);
        if (account?.hide) return;
        const { category_id } = e.label;
        if (!category_id) return;
        const newCategory = newCategories.get(category_id);
        if (!newCategory) return;
        (newCategory.amount as number) -= e.amount;
        newCategories.set(category_id, newCategory);
      });
      return newCategories;
    });
  }, [
    transactions,
    accounts,
    setCategories,
    budgets,
    selectedBudgetId,
    selectedInterval,
  ]);

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
    selectedInterval,
    setSelectedInterval,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
