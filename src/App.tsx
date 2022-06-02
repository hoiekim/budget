import { useState, createContext, Dispatch } from "react";
import { Home, User } from "pages";
import { Transaction, AccountBase } from "plaid";

interface ContextType {
  transactions: Transaction[];
  setTransactions: Dispatch<Transaction[]>;
  accounts: AccountBase[];
  setAccounts: Dispatch<AccountBase[]>;
  user: User | undefined;
  setUser: Dispatch<User>;
}

export const Context = createContext<ContextType>({} as ContextType);

export const Cache = {
  transactions: new Map<string, Transaction>(),
  accounts: new Map<string, AccountBase>(),
};

interface Props {
  initialUser: ContextType["user"];
}

const App = ({ initialUser }: Props) => {
  const [transactions, setTransactions] = useState<ContextType["transactions"]>(
    []
  );
  const [accounts, setAccounts] = useState<ContextType["accounts"]>([]);
  const [user, setUser] = useState<ContextType["user"]>(initialUser);

  const contextValue = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    user,
    setUser,
  };

  return (
    <div className="App">
      <Context.Provider value={contextValue}>
        <Home />
      </Context.Provider>
    </div>
  );
};

export default App;
