import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction,
  // RemovedTransaction,
  TransactionsSyncRequest,
  Institution,
} from "plaid";
import { User } from "server";

const { PLAID_CLIENT_ID, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } =
  process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET_DEVELOPMENT || !PLAID_SECRET_SANDBOX) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const getClient = (user: Omit<User, "password">) => {
  if (user.username === "demo") {
    const sandboxConfig = new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET_SANDBOX,
        },
      },
    });

    return new PlaidApi(sandboxConfig);
  } else {
    const devConfig = new Configuration({
      basePath: PlaidEnvironments.development,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET_DEVELOPMENT,
        },
      },
    });

    return new PlaidApi(devConfig);
  }
};

export const getLinkToken = async (user: Omit<User, "password">) => {
  const client = getClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.id },
    client_name: "Budget App",
    products: [Products.Auth, Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  };

  const response = await client.linkTokenCreate(request);

  return response.data;
};

export class Item {
  token: string;
  id: string;
  cursor?: string;

  constructor(token: string, id: string) {
    this.token = token;
    this.id = id;
  }
}

export const exchangePublicToken = async (
  user: Omit<User, "password">,
  public_token: string
) => {
  const client = getClient(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};

export const getTransactions = async (user: Omit<User, "password">) => {
  const client = getClient(user);

  try {
    const fetchJobs = user.items.map(async (item) => {
      try {
        const added: Transaction[][] = [];
        // const modified: Transaction[][] = [];
        // const removed: RemovedTransaction[][] = [];
        let hasMore = true;

        while (hasMore) {
          const request: TransactionsSyncRequest = {
            access_token: item.token,
            cursor: item.cursor,
          };
          const response = await client.transactionsSync(request);
          const data = response.data;
          added.push(data.added);
          // modified.push(data.modified);
          // removed.push(data.removed);
          hasMore = data.has_more;
          item.cursor = data.next_cursor;
        }

        return added.flat();
      } catch (error) {
        console.error(error);
        console.error("Failed to get transactions data for item:", item.id);
        return [];
      }
    });

    return (await Promise.all(fetchJobs)).flat();
  } catch (error) {
    console.error(error);
    console.error("Failed to get transactions data.");
  }
};

export const getAccounts = async (user: Omit<User, "password">) => {
  const client = getClient(user);

  try {
    const fetchJobs = user.items.map(async (item) => {
      try {
        const response = await client.accountsGet({ access_token: item.token });
        return response.data.accounts;
      } catch (error) {
        console.error(error);
        console.error("Failed to get accounts data for item:", item.id);
      }
      return [];
    });

    return (await Promise.all(fetchJobs)).flat();
  } catch (error) {
    console.error(error);
    console.error("Failed to get accounts data.");
  }
};

const institutionsCache = new Map<string, Institution>();

export const getInstitution = async (
  user: Omit<User, "password">,
  id: string
) => {
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
