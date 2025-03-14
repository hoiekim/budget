import { ContextType } from "client";
import { Header } from "client/components";
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
      <Header />
      <Router />
    </AppContext>
  );
};
