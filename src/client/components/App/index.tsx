import { ContextType } from "client";
import { Header, ErrorBoundary } from "client/components";
import Utility from "./Utility";
import Router from "./Router";
import AppContext from "./AppContext";
import "./index.css";
import "./variables.css";

interface Props {
  initialUser: ContextType["user"];
  sso: ContextType["sso"];
}

export const App = ({ initialUser, sso }: Props) => {
  return (
    <AppContext initialUser={initialUser} sso={sso}>
      <Utility />
      <ErrorBoundary>
        <Header />
        <Router />
      </ErrorBoundary>
    </AppContext>
  );
};
