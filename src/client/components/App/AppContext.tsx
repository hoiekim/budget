import { useState, ReactNode } from "react";
import {
  useLocalStorage,
  ContextType,
  Context,
  useRouter,
  Transactions,
  Accounts,
  Institutions,
} from "client";
import { MaskedUser } from "server";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const [transactions, setTransactions] = useState<Transactions>(new Map());
  const [accounts, setAccounts] = useState<Accounts>(new Map());
  const [institutions, setInstitutions] = useLocalStorage<Institutions>(
    "map_institutions",
    new Map()
  );
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);

  const router = useRouter();

  const contextValue = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    institutions,
    setInstitutions,
    user,
    setUser,
    router,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
