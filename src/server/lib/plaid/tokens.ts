import { CountryCode, LinkTokenCreateRequest, Products } from "plaid";
import { MaskedUser } from "server";
import { JSONItem } from "common";
import { getClient } from "./util";

const { HOST_NAME } = process.env;

export const getLinkToken = async (user: MaskedUser, access_token?: string) => {
  const client = getClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.user_id },
    client_name: "Budget App",
    country_codes: [CountryCode.Us],
    optional_products: [Products.Investments],
    language: "en",
    redirect_uri: `https://${HOST_NAME}/config`,
    webhook: `https://${HOST_NAME}/api/plaid-hook`,
  };

  if (access_token) {
    request.access_token = access_token;
    request.update = { account_selection_enabled: true };
  } else request.products = [Products.Transactions];

  const response = await client.linkTokenCreate(request);

  return response.data;
};

/**
 * Test seam for {@link exchangePublicToken}: the Plaid client factory.
 * Defaults are the production import, so callers pass nothing and behavior
 * is unchanged. Tests pass a fake here instead of mocking the shared leaf:
 * mock.module is process-global in Bun, and a module imported while a mock
 * is registered keeps the mock — mocking the plaid util in this file leaked
 * into sibling test files (see transactions.test.ts).
 */
export interface ExchangePublicTokenDeps {
  getClient?: typeof getClient;
}

export const exchangePublicToken = async (
  user: MaskedUser,
  public_token: string,
  deps: ExchangePublicTokenDeps = {},
) => {
  const { getClient: getClientFn = getClient } = deps;
  const client = getClientFn(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};

export const getItem = async (access_token: string) => {
  const client = getClient();

  const response = await client.itemGet({ access_token });

  return response.data.item;
};

export const deleteItem = async (user: MaskedUser, { access_token }: JSONItem) => {
  const client = getClient(user);

  const response = await client.itemRemove({ access_token });

  return response.data;
};
