import { CountryCode, LinkTokenCreateRequest, Products } from "plaid";
import { getPlaidClient, MaskedUser } from "server";

const { HOST_NAME } = process.env;

export const getLinkToken = async (user: MaskedUser, access_token?: string) => {
  const client = getPlaidClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.user_id },
    client_name: "Budget App",
    country_codes: [CountryCode.Us],
    language: "en",
    redirect_uri: `https://${HOST_NAME}/accounts`,
  };

  if (access_token) {
    request.access_token = access_token;
    request.update = { account_selection_enabled: true };
  } else request.products = [Products.Transactions];

  const response = await client.linkTokenCreate(request);

  return response.data;
};

export const exchangePublicToken = async (user: MaskedUser, public_token: string) => {
  const client = getPlaidClient(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};