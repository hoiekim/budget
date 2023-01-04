import { ContextType } from "client";
import { Header } from "client/components";
import Utility from "./Utility";
import Router from "./Router";
import AppContext from "./AppContext";
import ColorSchemeCover from "./ColorSchemeCover";
import "./index.css";

interface Props {
  initialUser: ContextType["user"];
}

const App = ({ initialUser }: Props) => {
  return (
    <AppContext initialUser={initialUser}>
      <Utility />
      <Header />
      <Router />
      <ColorSchemeCover />
    </AppContext>
  );
};

export default App;
