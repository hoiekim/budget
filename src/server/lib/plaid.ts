import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction as PlaidTransaction,
  TransactionsSyncRequest,
  AccountBase,
  Institution as PlaidInstitution,
  PlaidError,
  Item as PlaidItem,
} from "plaid";
import { MaskedUser } from "server";

export interface Transaction extends PlaidTransaction {
  /**
   * A hierarchical array of the categories to which this transaction belongs.
   * This property's value should be overwritten by users and if so, not longer
   * keep consistency of data provided by Plaid API.
   */
  category: string[] | null;
}

export interface Institution extends PlaidInstitution {}

const { PLAID_CLIENT_ID, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } = process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET_DEVELOPMENT || !PLAID_SECRET_SANDBOX) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const getClient = (user: MaskedUser) => {
  const isDemo = user.username === "demo";
  const config = new Configuration({
    basePath: isDemo ? PlaidEnvironments.sandbox : PlaidEnvironments.development,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": isDemo ? PLAID_SECRET_SANDBOX : PLAID_SECRET_DEVELOPMENT,
      },
    },
  });
  return new PlaidApi(config);
};

export const getLinkToken = async (user: MaskedUser, access_token?: string) => {
  const client = getClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.id },
    client_name: "Budget App",
    country_codes: [CountryCode.Us],
    language: "en",
  };

  if (access_token) request.access_token = access_token;
  else request.products = [Products.Auth, Products.Transactions, Products.Investments];

  const response = await client.linkTokenCreate(request);

  return response.data;
};

export interface Item {
  item_id: string;
  access_token: string;
  institution_id?: string;
  cursor?: string;
  plaidError?: PlaidError;
}

export const exchangePublicToken = async (user: MaskedUser, public_token: string) => {
  const client = getClient(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};

export const getItem = async (user: MaskedUser, access_token: string): Promise<Item> => {
  const client = getClient(user);

  const response = await client.itemGet({ access_token });

  const { item: plaidItem } = response.data;
  const { institution_id, item_id } = plaidItem;

  return { item_id, access_token, institution_id: institution_id || undefined };
};

export type ItemError = PlaidError & { item_id: string };

export interface TransactionsResponse {
  errors: ItemError[];
  transactions: Transaction[];
}

export const getTransactions = async (user: MaskedUser) => {
  const client = getClient(user);

  const data: TransactionsResponse = {
    errors: [],
    transactions: [],
  };

  const fetchJobs = user.items.map(async (item) => {
    const { item_id, access_token, cursor } = item;
    try {
      const added: Transaction[][] = [];
      let hasMore = true;

      while (hasMore) {
        const request: TransactionsSyncRequest = {
          access_token: access_token,
          cursor: cursor,
        };
        const response = await client.transactionsSync(request);
        const data = response.data;
        added.push(data.added);
        hasMore = data.has_more;
        item.cursor = data.next_cursor;
      }

      data.transactions = added.flat();
    } catch (error: any) {
      const plaidError = error.response.data as PlaidError;
      console.error(plaidError);
      console.error("Failed to get transactions data for item:", item_id);
      data.errors.push({ ...plaidError, item_id });
    }

    return;
  });

  await Promise.all(fetchJobs);

  return data;
};

export interface Account extends AccountBase {
  /**
   * The ID of the institution that the account belongs to.
   */
  institution_id?: string;
  /**
   * The ID of the item that the account belongs to.
   */
  item_id: string;
}

export interface AccountsResponse {
  errors: ItemError[];
  accounts: Account[];
}

export const getAccounts = async (user: MaskedUser) => {
  const client = getClient(user);

  const data: AccountsResponse = {
    errors: [],
    accounts: [],
  };

  const fetchJobs = user.items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: Account[] = accounts.map((e) => {
        return { ...e, institution_id, item_id };
      });
      data.accounts = filledAccounts;
    } catch (error: any) {
      const plaidError = error.response.data as PlaidError;
      console.error(plaidError);
      console.error("Failed to get accounts data for item:", item_id);
      data.errors.push({ ...plaidError, item_id });
    }

    return;
  });

  await Promise.all(fetchJobs);

  return data;
};

const institutionsCache = new Map<string, Institution>();

export const getInstitution = async (user: MaskedUser, id: string) => {
  const client = getClient(user);

  const cachedData = institutionsCache.get(id);
  if (cachedData) return cachedData;

  try {
    const response = await client.institutionsGetById({
      institution_id: id,
      country_codes: [CountryCode.Us],
    });

    const { institution } = response.data;

    if (institution) institutionsCache.set(id, institution);

    return institution;
  } catch (error) {
    console.error(error);
    console.error("Failed to get institutions data.");
  }
};
