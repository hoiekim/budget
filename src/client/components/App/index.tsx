import { ContextType } from "client";
import Utility from "./Utility";
import Router from "./Router";
import AppContext from "./AppContext";

interface Props {
  initialUser: ContextType["user"];
}

const App = ({ initialUser }: Props) => {
  return (
    <AppContext initialUser={initialUser}>
      <Utility />
      <Router />
    </AppContext>
  );
};

export default App;
