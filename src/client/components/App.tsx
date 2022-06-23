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
  const [transactions, setTransactions] = useState<ContextType["transactions"]>(
    new Map()
  );
  const [accounts, setAccounts] = useState<ContextType["accounts"]>(new Map());
  const [user, setUser] = useState<ContextType["user"]>(initialUser);

  const router = useRouter();
  const { path, go } = router;

  useEffect(() => {
    if (!user && path !== "/login") go("/login");
  }, [user, go, path]);

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
    <Context.Provider value={contextValue}>
      <Router path={path} />
    </Context.Provider>
  );
};

export default App;
