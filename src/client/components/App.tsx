import { useState } from "react";
import { Home, ContextType, Context } from "client";

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
