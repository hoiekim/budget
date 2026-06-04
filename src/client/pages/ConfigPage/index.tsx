import { Configuration, Page, PlaidLinkProvider } from "client/components";

export const ConfigPage = () => {
  return (
    <PlaidLinkProvider>
      <Page className="ConfigPage">
        <Configuration />
      </Page>
    </PlaidLinkProvider>
  );
};
