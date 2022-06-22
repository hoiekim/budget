import { useEffect, useState } from "react";
import { ContextType, Context, useRouter } from "client";
import { Home, Login } from "client/pages";

interface RouterProps {
  path: string;
}

const Router = ({ path }: RouterProps) => {
  if (path === "/login") {
    return <Login />;
  }
  return <Home />;
};

interface AppProps {
  initialUser: ContextType["user"];
}

const App = ({ initialUser }: AppProps) => {
  const [transactions, setTransactions] = useState<ContextType["transactions"]>([]);
  const [accounts, setAccounts] = useState<ContextType["accounts"]>([]);
  const [user, setUser] = useState<ContextType["user"]>(initialUser);

  const router = useRouter();
  const { path, go } = router;

  useEffect(() => {
    if (go && !user) go("/login");
  }, [user, go]);

  const contextValue = {
    transactions,
    setTransactions,
    accounts,
    setAccounts,
    user,
    setUser,
    router,
  };

  return (
    <div className="App">
      <Context.Provider value={contextValue}>
        <Router path={path} />
      </Context.Provider>
    </div>
  );
};

export default App;
