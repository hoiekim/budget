import { Configuration, PlaidLinkProvider } from "client/components";

export const ConfigPage = () => {
  return (
    <PlaidLinkProvider>
      <div className="ConfigPage">
        <Configuration />
      </div>
    </PlaidLinkProvider>
  );
};
