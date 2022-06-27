import { useState, ReactNode } from "react";
import { ContextType, Context, useRouter, Transactions, Accounts } from "client";
import { MaskedUser } from "server";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const [transactions, setTransactions] = useState<Transactions>(new Map());
  const [accounts, setAccounts] = useState<Accounts>(new Map());
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);

  const router = useRouter();

  const contextValue = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    user,
    setUser,
    router,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
