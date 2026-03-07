import { Configuration, PlaidLinkProvider } from "client/components";

import "./index.css";

export const ConfigPage = () => {
  return (
    <PlaidLinkProvider>
      <div className="ConfigPage">
        <Configuration />
      </div>
    </PlaidLinkProvider>
  );
};
