import { ContextType } from "client";
import { Header, ErrorBoundary, PlaidLinkProvider } from "client/components";
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
      <PlaidLinkProvider>
        <Utility />
        <ErrorBoundary>
          <Header />
          <Router />
        </ErrorBoundary>
      </PlaidLinkProvider>
    </AppContext>
  );
};
