import { ContextType } from "client";
import { Header, ErrorBoundary } from "client/components";
import Utility from "./Utility";
import Router from "./Router";
import AppContext from "./AppContext";
import "./index.css";
import "./variables.css";

interface Props {
  initialUser: ContextType["user"];
}

export const App = ({ initialUser }: Props) => {
  return (
    <AppContext initialUser={initialUser}>
      <Utility />
      <ErrorBoundary>
        <Header />
        <Router />
      </ErrorBoundary>
    </AppContext>
  );
};
