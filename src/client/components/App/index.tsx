import { Suspense } from "react";
import { ContextType } from "client";
import { Header } from "client/components";
import Utility from "./Utility";
import Router from "./Router";
import AppContext from "./AppContext";
import Cover from "./Cover";
import "./index.css";

interface Props {
  initialUser: ContextType["user"];
}

const App = ({ initialUser }: Props) => {
  return (
    <AppContext initialUser={initialUser}>
      <Utility />
      <Header />
      <Suspense fallback={<div className="loading">Loading...</div>}>
        <Router />
      </Suspense>
      <Cover />
    </AppContext>
  );
};

export default App;
